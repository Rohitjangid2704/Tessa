import argparse
import io
import os
import re
import subprocess
import sys
import time
import uuid
import zipfile
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_BUNDLE = Path(__file__).resolve().parent / "bundle" / "tessa"
API_PREFIX = "/api/v1"
TOKEN_LINE = re.compile(r"^target_token:.*$", re.MULTILINE)
TERMINAL_RUN_STATUSES = frozenset(
    {"completed", "failed", "canceled", "budget_exceeded"}
)
DEFECT = "dirty_filter_ignored"
FAILING_SCENARIO_KEY = "smoke-dirty-filter"
WRITE_SCENARIO_KEY = "smoke-create-issue"
JUDGED_SCENARIO_KEY = "smoke-open-issues-chat"
BROWSER_SCENARIO_KEY = "smoke-browser-login"
AUTHORED_KEYS = (
    FAILING_SCENARIO_KEY,
    WRITE_SCENARIO_KEY,
    JUDGED_SCENARIO_KEY,
    BROWSER_SCENARIO_KEY,
)
STATUS_POLL_SECONDS = 5.0
ORACLE_POLL_SECONDS = 1.0
ORACLE_TIMEOUT_SECONDS = 60.0
REVIEW_WAIT_SECONDS = 600.0
PROBE_ONLY_INVARIANTS = (
    "refuses_out_of_scope",
    "injection_resistance",
    "authority_pressure",
)
FIXED_ZIP_TIME = (2026, 1, 1, 0, 0, 0)
FEED_READ_TIMEOUT_SECONDS = 90.0


class SmokeFailure(Exception):
    pass


@dataclass(frozen=True)
class SmokeConfig:
    api_url: str
    target_url: str
    bundle_dir: Path
    email: str
    token: str | None
    environment: Mapping[str, str] = field(repr=False)
    run_timeout_seconds: float
    interface_mode: str
    token_out: Path | None
    keep_target_defect: bool


@dataclass
class SmokeState:
    target_id: str = ""
    target_name: str = ""
    target_token: str = ""
    bundle_id: str = ""
    plan_id: str = ""
    suite_run_id: str = ""
    subset_run_id: str = ""
    finding_id: str = ""
    scenario_ids: dict[str, str] = field(default_factory=dict)
    personal_token: str = field(default="", repr=False)
    personal_token_id: str = ""
    laya_reachable: bool = False
    feed_events: int = 0


def environment_value(name: str, fallback: str) -> str:
    return os.environ.get(name) or fallback


def parse_arguments(argv: list[str]) -> SmokeConfig:
    parser = argparse.ArgumentParser(
        description=(
            "Walk the Tessa 1.x core loop against a running stack and the fake target "
            "(cd worker && uv run python -m tests.fake_target --port 8600 --database, with "
            "FAKE_TARGET_DSN set to a write connection of the truth_fixture database). "
            "Secrets are read from the environment and never printed."
        )
    )
    parser.add_argument(
        "--api-url",
        default=environment_value("TESSA_SMOKE_API_URL", "http://127.0.0.1:8000"),
    )
    parser.add_argument(
        "--target-url",
        default=environment_value(
            "TESSA_SMOKE_TARGET_URL", "http://127.0.0.1:8600"
        ),
    )
    parser.add_argument("--bundle-dir", type=Path, default=DEFAULT_BUNDLE)
    parser.add_argument(
        "--email",
        default=environment_value("TESSA_SMOKE_EMAIL", "admin@tessa.local"),
        help="user the dev token is signed for when TESSA_SMOKE_TOKEN is not set",
    )
    parser.add_argument("--run-timeout", type=float, default=1200.0)
    parser.add_argument(
        "--interface-mode", choices=("api_only", "both"), default="both"
    )
    parser.add_argument(
        "--token-out",
        type=Path,
        help="write the minted personal token to this file instead of revoking it at the end",
    )
    parser.add_argument("--keep-target-defect", action="store_true")
    arguments = parser.parse_args(argv)
    environment = {
        "FAKE_TARGET_URL": arguments.target_url,
        "STAFF_EMAIL": environment_value("SMOKE_STAFF_EMAIL", "staff@fake.test"),
        "STAFF_PASSWORD": environment_value(
            "SMOKE_STAFF_PASSWORD", "dev-only-fake-staff-password"
        ),
        "MANAGER_TOKEN": environment_value(
            "SMOKE_MANAGER_TOKEN", "dev-only-fake-manager-token-0123456789"
        ),
        "TRUTH_DB_DSN": environment_value(
            "SMOKE_TRUTH_DB_DSN",
            "postgresql://truth_ro:dev-only-truth-ro-password@127.0.0.1:5440/truth_fixture",
        ),
        "SEED_DB_DSN": environment_value(
            "SMOKE_SEED_DB_DSN",
            "postgresql://seed_rw:dev-only-seed-rw-password@127.0.0.1:5440/truth_fixture",
        ),
    }
    return SmokeConfig(
        api_url=arguments.api_url.rstrip("/"),
        target_url=arguments.target_url.rstrip("/"),
        bundle_dir=arguments.bundle_dir,
        email=arguments.email,
        token=os.environ.get("TESSA_SMOKE_TOKEN"),
        environment=environment,
        run_timeout_seconds=arguments.run_timeout,
        interface_mode=arguments.interface_mode,
        token_out=arguments.token_out,
        keep_target_defect=arguments.keep_target_defect,
    )


def mint_dev_token(email: str) -> str:
    completed = subprocess.run(
        [
            "uv",
            "run",
            "python",
            "scripts/dev_token.py",
            "--email",
            email,
            "--ttl",
            "14400",
        ],
        cwd=REPOSITORY_ROOT / "api",
        capture_output=True,
        text=True,
        check=False,
    )
    lines = [line.strip() for line in completed.stdout.splitlines() if line.strip()]
    if completed.returncode != 0 or not lines:
        raise SmokeFailure(f"dev_token.py failed with exit code {completed.returncode}")
    return lines[-1]


def zip_bundle(bundle_dir: Path, target_token: str) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(bundle_dir.rglob("*")):
            if not path.is_file():
                continue
            relative = path.relative_to(bundle_dir).as_posix()
            content = path.read_bytes()
            if relative == "manifest.yaml":
                text = content.decode("utf-8")
                content = TOKEN_LINE.sub(
                    f"target_token: {target_token}", text, count=1
                ).encode()
            info = zipfile.ZipInfo(f"tessa/{relative}", date_time=FIXED_ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, content)
    return buffer.getvalue()


def sse_frames(lines: Iterator[str]) -> Iterator[tuple[str, str]]:
    event = "message"
    data: list[str] = []
    for line in lines:
        if line == "":
            if data or event != "message":
                yield event, "\n".join(data)
            event, data = "message", []
            continue
        name, _, value = line.partition(":")
        value = value.removeprefix(" ")
        if name == "event":
            event = value
        elif name == "data":
            data.append(value)


class Smoke:
    def __init__(self, config: SmokeConfig) -> None:
        self.config = config
        self.state = SmokeState()
        self.started = time.monotonic()
        self.results: list[tuple[str, str, float]] = []
        self.api: httpx.Client | None = None
        self.target = httpx.Client(base_url=config.target_url, timeout=30)

    def client(self) -> httpx.Client:
        if self.api is None:
            raise SmokeFailure("the API client is not ready")
        return self.api

    def agent_client(self) -> httpx.Client:
        return httpx.Client(
            base_url=self.config.api_url + API_PREFIX,
            headers={"Authorization": f"Bearer {self.state.personal_token}"},
            timeout=60,
        )

    def expect(self, condition: bool, message: str) -> None:
        if not condition:
            raise SmokeFailure(message)

    def ok(self, response: httpx.Response, *statuses: int) -> Any:
        if response.status_code not in statuses:
            raise SmokeFailure(
                f"{response.request.method} {response.request.url.path} answered "
                f"{response.status_code}: {response.text[:600]}"
            )
        return response.json() if response.content else None

    def idempotent(self) -> dict[str, str]:
        return {"Idempotency-Key": f"smoke-{uuid.uuid4()}"}

    def step(self, name: str, action: Callable[[], str]) -> None:
        begun = time.monotonic()
        try:
            detail = action()
        except SmokeFailure as failure:
            elapsed = time.monotonic() - begun
            self.results.append((name, f"FAIL {failure}", elapsed))
            print(f"FAIL {name} ({elapsed:.1f}s): {failure}", flush=True)
            raise
        elapsed = time.monotonic() - begun
        self.results.append((name, f"ok {detail}", elapsed))
        print(f"ok   {name} ({elapsed:.1f}s): {detail}", flush=True)

    def authenticate(self) -> str:
        token = self.config.token or mint_dev_token(self.config.email)
        self.api = httpx.Client(
            base_url=self.config.api_url + API_PREFIX,
            headers={"Authorization": f"Bearer {token}"},
            timeout=60,
        )
        me = self.ok(self.client().get("/users/me"), 200)
        self.expect(
            me["role"] in ("admin", "member"), f"the smoke user is a {me['role']}"
        )
        source = "TESSA_SMOKE_TOKEN" if self.config.token else "dev_token.py"
        return f"{me['email']} ({me['role']}) via {source}"

    def dependencies(self) -> str:
        response = self.client().get(self.config.api_url + "/health/dependencies")
        body = self.ok(response, 200)
        for name in ("db", "temporal", "storage"):
            self.expect(
                body[name]["status"] == "up", f"dependency {name}: {body[name]}"
            )
        self.state.laya_reachable = body["laya"]["status"] == "up"
        target = self.ok(self.target.get("/health"), 200)
        self.expect(target == {"status": "ok"}, "the fake target is not healthy")
        defects = self.ok(self.target.get("/qa/defects"), 200)
        self.expect(DEFECT in defects["known"], "the fake target has no defect switch")
        laya_state = (
            "reachable" if self.state.laya_reachable else "unreachable (no Tier 1)"
        )
        return f"fake target healthy, Laya {laya_state}"

    def create_target(self) -> str:
        self.state.target_name = f"smoke-{time.strftime('%Y%m%d-%H%M%S')}"
        body = {
            "name": self.state.target_name,
            "app_kind": "llm_assistant",
            "tier": "qa",
        }
        target = self.ok(self.client().post("/targets", json=body), 201)
        self.state.target_id = target["id"]
        self.state.target_token = target["target_token"]
        return f"target {self.state.target_name} {self.state.target_id}"

    def discovery_prompt(self) -> str:
        issue = self.ok(
            self.client().post(
                f"/targets/{self.state.target_id}/prompt-issues",
                json={"template_name": "discovery"},
            ),
            201,
        )
        self.expect(
            self.state.target_token in issue["text"],
            "the prompt lacks the target token",
        )
        return (
            f"discovery v{issue['template_version']}, {len(issue['text'])} characters"
        )

    def upload_bundle(self) -> str:
        archive = zip_bundle(self.config.bundle_dir, self.state.target_token)
        response = self.client().post(
            "/bundles",
            headers=self.idempotent(),
            files={"file": ("tessa.zip", archive, "application/zip")},
            data={"target_id": self.state.target_id, "note": "phase 0 smoke"},
        )
        upload = self.ok(response, 201)
        bundle = upload["bundle"]
        self.state.bundle_id = bundle["id"]
        self.expect(
            bundle["validation_status"] == "valid",
            f"bundle invalid: {bundle['errors'][:3]}",
        )
        self.expect(
            bundle["scenarios_imported"] == len(AUTHORED_KEYS),
            f"{bundle['scenarios_imported']} scenarios imported, warnings {bundle['warnings'][:3]}",
        )
        return (
            f"bundle v{bundle['version']} valid, score {bundle['completeness']['score']}, "
            f"{bundle['scenarios_imported']} scenarios imported"
        )

    def set_environment(self) -> str:
        body = {"set": dict(self.config.environment)}
        page = self.ok(
            self.client().patch(
                f"/targets/{self.state.target_id}/environment", json=body
            ),
            200,
        )
        missing = [item["name"] for item in page["items"] if not item["has_value"]]
        self.expect(not missing, f"variables without a value: {missing}")
        leaked = [
            item["name"] for item in page["items"] if item["secret"] and item["value"]
        ]
        self.expect(not leaked, f"secret values echoed back: {leaked}")
        return f"{len(page['items'])} variables set, secrets not echoed"

    def health_checks(self) -> str:
        health = self.ok(
            self.client().post(
                f"/targets/{self.state.target_id}/health-checks", json={}
            ),
            200,
            202,
        )
        if not health or "interfaces" not in health:
            health = self.ok(
                self.client().get(f"/targets/{self.state.target_id}/health"), 200
            )
        statuses = {
            item["interface_id"]: item["status"] for item in health["interfaces"]
        }
        self.expect(
            all(status == "ok" for status in statuses.values()), f"health {statuses}"
        )
        return ", ".join(
            f"{name} {status}" for name, status in sorted(statuses.items())
        )

    def read_catalog(self) -> str:
        catalog = self.ok(
            self.client().get("/catalog", params={"target_id": self.state.target_id}),
            200,
        )
        features = [
            item["feature_id"] for area in catalog["areas"] for item in area["items"]
        ]
        self.expect(len(features) == 4, f"catalog features {features}")
        scenarios = self.ok(
            self.client().get(
                "/scenarios", params={"target_id": self.state.target_id, "limit": 100}
            ),
            200,
        )
        for item in scenarios["items"]:
            detail = self.ok(self.client().get(f"/scenarios/{item['id']}"), 200)
            key = (detail.get("parsed") or {}).get("id")
            if key in AUTHORED_KEYS:
                self.state.scenario_ids[key] = item["id"]
        missing = [key for key in AUTHORED_KEYS if key not in self.state.scenario_ids]
        self.expect(not missing, f"authored scenarios not found: {missing}")
        statuses = sorted({item["status"] for item in scenarios["items"]})
        return f"{len(features)} features, {len(scenarios['items'])} scenarios ({statuses})"

    def approve_oracles(self) -> str:
        page = self.ok(
            self.client().get(
                "/oracle-templates",
                params={"target_id": self.state.target_id, "limit": 50},
            ),
            200,
        )
        templates = [
            item for item in page["items"] if item["bundle_id"] == self.state.bundle_id
        ]
        self.expect(len(templates) == 4, f"{len(templates)} oracle templates")
        sentences = []
        for template in templates:
            params = (
                {"description": "nothing"}
                if template["name"] == "issue_by_description"
                else {}
            )
            result = self.ok(
                self.client().post(
                    f"/oracle-templates/{template['id']}/runs",
                    headers=self.idempotent(),
                    json={"params": params},
                ),
                200,
                202,
            )
            result = self.wait_oracle(result)
            self.expect(
                result["status"] == "ok",
                f"oracle {template['name']}: {result['error']}",
            )
            self.ok(
                self.client().put(
                    f"/oracle-templates/{template['id']}/approval",
                    json={"approved": True, "oracle_result_id": result["id"]},
                ),
                200,
            )
            sentences.append(f"{template['name']}: {result['sentence']}")
        return "; ".join(sentences)

    def wait_oracle(self, result: dict[str, Any]) -> dict[str, Any]:
        deadline = time.monotonic() + ORACLE_TIMEOUT_SECONDS
        while result["status"] in ("pending", "running", "queued"):
            self.expect(time.monotonic() < deadline, "the oracle run did not finish")
            time.sleep(ORACLE_POLL_SECONDS)
            result = self.ok(self.client().get(f"/oracle-results/{result['id']}"), 200)
        return result

    def review_scenarios(self) -> str:
        deadline = time.monotonic() + REVIEW_WAIT_SECONDS
        decisions = []
        for key in AUTHORED_KEYS:
            scenario_id = self.state.scenario_ids[key]
            scenario = self.ok(self.client().get(f"/scenarios/{scenario_id}"), 200)
            while scenario["status"] in ("draft", "validating"):
                self.expect(
                    time.monotonic() < deadline, f"{key} is still {scenario['status']}"
                )
                time.sleep(STATUS_POLL_SECONDS)
                scenario = self.ok(self.client().get(f"/scenarios/{scenario_id}"), 200)
            self.expect(
                scenario["status"] == "in_review", f"{key} is {scenario['status']}"
            )
            dry_runs = [
                warning["code"]
                for warning in scenario["validation"]["warnings"]
                if warning["code"].startswith("dry_run")
            ]
            reviewed = self.ok(
                self.client().post(
                    f"/scenarios/{scenario_id}/review",
                    json={"decision": "accept", "note": "phase 0 smoke"},
                ),
                200,
            )
            self.expect(
                reviewed["status"] == "accepted",
                f"{key} review gave {reviewed['status']}",
            )
            decisions.append(f"{key} ({', '.join(dry_runs) or 'dry runs passed'})")
        return "accepted " + "; ".join(decisions)

    def reset_seed(self) -> str:
        handle = self.ok(
            self.client().post(
                f"/targets/{self.state.target_id}/seeds/reset",
                headers=self.idempotent(),
                json={"confirm_target_name": self.state.target_name},
            ),
            202,
        )
        run = self.follow_run(handle["run_id"])
        self.expect(run["status"] == "completed", f"seed run ended {run['status']}")
        seeds = self.ok(
            self.client().get(f"/targets/{self.state.target_id}/seeds"), 200
        )
        seed = seeds["items"][0]
        self.expect(
            seed["last_reset_status"] in ("ok", "matched", "succeeded"), f"seed {seed}"
        )
        self.expect(
            bool(seed["declared_hash"] or seed["observed_hash"]),
            "no seed hash recorded",
        )
        return f"seed run {run['id']} completed, hash {seed['observed_hash']}"

    def enable_defect(self) -> str:
        body = self.ok(
            self.target.put(f"/qa/defects/{DEFECT}", json={"enabled": True}), 200
        )
        self.expect(DEFECT in body["enabled"], "the defect did not switch on")
        return f"fake target defect {DEFECT} on"

    def create_plan(self) -> str:
        catalog = self.ok(
            self.client().get("/catalog", params={"target_id": self.state.target_id}),
            200,
        )
        features = [
            item["feature_id"] for area in catalog["areas"] for item in area["items"]
        ]
        selection = {
            "feature_ids": features,
            "roles": ["staff"],
            "interface_mode": self.config.interface_mode,
            "depth": "smoke",
            "k": 1,
        }
        plan = self.ok(
            self.client().post(
                "/plans",
                headers=self.idempotent(),
                json={
                    "target_id": self.state.target_id,
                    "saved": True,
                    "name": "Phase 0 smoke",
                    "selection": selection,
                },
            ),
            201,
        )
        self.state.plan_id = plan["id"]
        self.expect(plan["cells_total"] > 0, "the plan has no cells")
        return f"plan {plan['id']} with {plan['cells_total']} cells"

    def start_suite_run(self) -> str:
        handle = self.ok(
            self.client().post(
                "/runs",
                headers=self.idempotent(),
                json={"plan_id": self.state.plan_id, "reset_seed": True},
            ),
            202,
        )
        self.state.suite_run_id = handle["run_id"]
        run = self.follow_run(handle["run_id"])
        self.expect(run["status"] == "completed", f"suite run ended {run['status']}")
        return f"run {run['id']} {run['status']}, counters {run['counters']}"

    def follow_run(self, run_id: str) -> dict[str, Any]:
        deadline = time.monotonic() + self.config.run_timeout_seconds
        last_poll = 0.0
        events = 0
        timeout = httpx.Timeout(30.0, read=FEED_READ_TIMEOUT_SECONDS)
        while time.monotonic() < deadline:
            try:
                with self.client().stream(
                    "GET", "/feeds/runs", params={"run_id": run_id}, timeout=timeout
                ) as response:
                    self.expect(
                        response.status_code == 200, f"feed {response.status_code}"
                    )
                    for event, _ in sse_frames(response.iter_lines()):
                        events += 1
                        self.state.feed_events += 1
                        if (
                            event == "run.finished"
                            or time.monotonic() - last_poll > STATUS_POLL_SECONDS
                        ):
                            last_poll = time.monotonic()
                            run = self.ok(self.client().get(f"/runs/{run_id}"), 200)
                            if run["status"] in TERMINAL_RUN_STATUSES:
                                return run
                        if time.monotonic() > deadline:
                            break
            except httpx.ReadTimeout:
                pass
            run = self.ok(self.client().get(f"/runs/{run_id}"), 200)
            if run["status"] in TERMINAL_RUN_STATUSES:
                return run
        raise SmokeFailure(
            f"run {run_id} did not finish within {self.config.run_timeout_seconds}s"
        )

    def run_scenarios(self, run_id: str) -> list[dict[str, Any]]:
        page = self.ok(
            self.client().get(f"/runs/{run_id}/scenarios", params={"limit": 200}), 200
        )
        return list(page["items"])

    def run_scenario_of(self, run_id: str, key: str) -> dict[str, Any]:
        scenario_id = self.state.scenario_ids[key]
        for item in self.run_scenarios(run_id):
            if item["scenario_id"] == scenario_id:
                detail: dict[str, Any] = self.ok(
                    self.client().get(f"/run-scenarios/{item['id']}"), 200
                )
                return detail
        raise SmokeFailure(f"scenario {key} is not part of run {run_id}")

    def steps_of(self, run_scenario: dict[str, Any]) -> list[dict[str, Any]]:
        steps = []
        for summary in run_scenario["steps"]:
            steps.append(self.ok(self.client().get(f"/steps/{summary['id']}"), 200))
        return steps

    def read_suite_run(self) -> str:
        run = self.ok(self.client().get(f"/runs/{self.state.suite_run_id}"), 200)
        items = self.run_scenarios(self.state.suite_run_id)
        self.expect(len(items) >= len(AUTHORED_KEYS), f"{len(items)} run scenarios")
        unfinished = [item["title"] for item in items if item["status"] != "finished"]
        self.expect(not unfinished, f"scenarios not finished: {unfinished}")
        verdicts: dict[str, int] = {}
        for item in items:
            status = (item.get("verdict") or {}).get("status", "none")
            verdicts[status] = verdicts.get(status, 0) + 1
        self.expect(run["trigger"] == "manual", f"trigger {run['trigger']}")
        return f"{len(items)} scenarios, verdicts {verdicts}"

    def seed_gate(self) -> str:
        run = self.ok(self.client().get(f"/runs/{self.state.suite_run_id}"), 200)
        seed_hash = run["config_snapshot"].get("seed_hash")
        self.expect(
            bool(seed_hash),
            "the run has no pinned seed hash: the seed gate did not pass",
        )
        return f"seed hash {seed_hash} pinned in the run config"

    def oracle_gold_point(self) -> str:
        detail = self.run_scenario_of(self.state.suite_run_id, FAILING_SCENARIO_KEY)
        steps = self.steps_of(detail)
        gold = [point for step in steps for point in (step.get("gold_points") or [])]
        keys = {point["key"]: point["value"] for point in gold}
        self.expect(keys.get("dirty_count") == 3, f"gold points {keys}")
        verdict = detail["verdict"] or {}
        self.expect(
            verdict.get("status") == "fail" and verdict.get("tier") == "code",
            f"the defect should fail the oracle-backed scenario at code tier, got {verdict}",
        )
        return f"gold dirty_count=3 from the oracle; with the defect the scenario fails: {verdict.get('reason')}"

    def expect_db_check(self) -> str:
        detail = self.run_scenario_of(self.state.suite_run_id, WRITE_SCENARIO_KEY)
        steps = self.steps_of(detail)
        checks = [check for step in steps for check in (step.get("db_checks") or [])]
        self.expect(bool(checks), "the write step has no database checks")
        failed = [check for check in checks if check["status"] != "pass"]
        self.expect(not failed, f"database checks failed: {failed}")
        verdict = detail["verdict"] or {}
        self.expect(
            verdict.get("status") == "pass", f"write scenario verdict {verdict}"
        )
        return f"{len(checks)} database checks pass after the write"

    def judged_step(self) -> str:
        detail = self.run_scenario_of(self.state.suite_run_id, JUDGED_SCENARIO_KEY)
        steps = self.steps_of(detail)
        verdict = detail["verdict"] or {}
        judged = [step for step in steps if step.get("judge")]
        probed = [step for step in steps if step.get("probes")]
        if self.state.laya_reachable:
            self.expect(
                bool(judged or probed),
                "the chat step was graded by neither Laya nor the judge",
            )
            self.expect(
                verdict.get("status") != "pass" or verdict.get("tier") != "code",
                f"free text passed at code tier: {verdict}",
            )
            return f"chat step graded with Laya up: {verdict.get('status')} at {verdict.get('tier')}"
        self.expect(bool(judged), "Laya is down and the chat step has no judge result")
        judge = judged[0]["judge"]
        step_verdict = judged[0].get("verdict") or {}
        self.expect(
            step_verdict.get("tier") == "judge"
            and step_verdict.get("status") == "pass",
            f"Laya is down, the judged step verdict is {step_verdict}",
        )
        self.expect(
            verdict.get("status") in ("pass", "uncertain"),
            f"Laya is down, the scenario verdict is {verdict}",
        )
        probe_only = [
            item
            for item in self.run_scenarios(self.state.suite_run_id)
            if any(name in item["title"] for name in PROBE_ONLY_INVARIANTS)
        ]
        passed = [
            item["title"]
            for item in probe_only
            if (item.get("verdict") or {}).get("status") == "pass"
        ]
        self.expect(bool(probe_only), "the run has no probe-only invariant scenario")
        self.expect(
            not passed, f"without Laya these passed with no reference: {passed}"
        )
        return (
            f"step graded by judge {judge.get('model')}: {step_verdict.get('status')}; scenario "
            f"{verdict.get('status')} at {verdict.get('tier')} ({verdict.get('reason')}); "
            f"{len(probe_only)} probe-only invariant scenarios fell through to "
            f"{sorted({(item.get('verdict') or {}).get('status') for item in probe_only})}, none passed"
        )

    def browser_scenario(self) -> str:
        detail = self.run_scenario_of(self.state.suite_run_id, BROWSER_SCENARIO_KEY)
        steps = self.steps_of(detail)
        self.expect(bool(steps), "the browser scenario recorded no steps")
        with_artifacts = [step for step in steps if step.get("artifacts")]
        kinds = sorted(
            {
                artifact["kind"]
                for step in steps
                for artifact in (step.get("artifacts") or [])
            }
        )
        self.expect(
            len(with_artifacts) == len(steps),
            f"{len(steps) - len(with_artifacts)} of {len(steps)} browser steps have no artifact",
        )
        sessions = self.ok(
            self.client().get(f"/runs/{self.state.suite_run_id}/browser-sessions"), 200
        )
        session_items = (
            sessions.get("items", sessions) if isinstance(sessions, dict) else sessions
        )
        verdict = detail["verdict"] or {}
        return (
            f"{len(steps)} steps, artifact kinds {kinds}, {len(session_items)} browser sessions, "
            f"verdict {verdict.get('status')}"
        )

    def finding_with_repro(self) -> str:
        page = self.ok(
            self.client().get(
                "/findings",
                params={
                    "target_id": self.state.target_id,
                    "scenario_id": self.state.scenario_ids[FAILING_SCENARIO_KEY],
                },
            ),
            200,
        )
        self.expect(
            bool(page["items"]), "triage filed no finding for the failing scenario"
        )
        finding = page["items"][0]
        self.state.finding_id = finding["id"]
        repro = self.ok(self.client().get(f"/findings/{finding['id']}/repro"), 200)
        self.expect(bool(repro.get("scenario_yaml")), "the repro has no scenario")
        self.expect(
            repro.get("run_id") == self.state.suite_run_id,
            "the repro names another run",
        )
        return f"finding {finding['class']}/{finding['severity']} '{finding['title']}', repro with seed {repro.get('seed') is not None}"

    def post_explanation(self) -> str:
        body = {
            "text": "The rooms route ignores the status filter while the defect is switched on.",
            "structured": {
                "opinion": "app_bug",
                "root_cause": "GET /api/rooms drops the status filter when dirty_filter_ignored is on",
                "confidence": "high",
                "files": [{"path": "worker/tests/fake_target/app.py"}],
            },
        }
        response = self.client().post(
            f"/findings/{self.state.finding_id}/explanations",
            headers=self.idempotent(),
            json=body,
        )
        explanation = self.ok(response, 200, 201)
        finding = self.ok(self.client().get(f"/findings/{self.state.finding_id}"), 200)
        self.expect(
            finding["latest_explanation"] is not None,
            "the finding shows no explanation",
        )
        return f"explanation {explanation['id']} stored"

    def mint_personal_token(self) -> str:
        created = self.ok(
            self.client().post(
                "/users/me/tokens",
                json={"name": f"smoke {time.strftime('%H%M%S')}", "expires_in_days": 1},
            ),
            201,
        )
        self.state.personal_token = created["token"]
        self.state.personal_token_id = created["item"]["id"]
        with self.agent_client() as agent:
            me = self.ok(agent.get("/users/me"), 200)
        if self.config.token_out is not None:
            self.config.token_out.write_text(
                self.state.personal_token, encoding="utf-8"
            )
        return f"personal token {self.state.personal_token_id} works for {me['email']}"

    def flip_target(self) -> str:
        body = self.ok(
            self.target.put(f"/qa/defects/{DEFECT}", json={"enabled": False}), 200
        )
        self.expect(DEFECT not in body["enabled"], "the defect did not switch off")
        with self.agent_client() as agent:
            for status in ("in_fix", "verifying"):
                self.ok(
                    agent.patch(
                        f"/findings/{self.state.finding_id}", json={"status": status}
                    ),
                    200,
                )
            finding = self.ok(agent.get(f"/findings/{self.state.finding_id}"), 200)
        self.expect(
            finding["status"] == "verifying", f"finding status {finding['status']}"
        )
        return "defect off, finding moved to verifying with the personal token"

    def subset_run(self) -> str:
        scenario_id = self.state.scenario_ids[FAILING_SCENARIO_KEY]
        with self.agent_client() as agent:
            handle = self.ok(
                agent.post(
                    "/runs",
                    headers=self.idempotent(),
                    json={
                        "target_id": self.state.target_id,
                        "scenario_ids": [scenario_id],
                        "reset_seed": True,
                    },
                ),
                202,
            )
        self.state.subset_run_id = handle["run_id"]
        run = self.follow_run(handle["run_id"])
        self.expect(run["status"] == "completed", f"subset run ended {run['status']}")
        self.expect(run["trigger"] == "agent", f"subset run trigger {run['trigger']}")
        self.expect(
            run["config_snapshot"].get("scenario_ids") == [scenario_id],
            f"subset scenario ids {run['config_snapshot'].get('scenario_ids')}",
        )
        self.expect(
            bool(run["config_snapshot"].get("seed_hash")),
            "the subset run pinned no seed",
        )
        items = self.run_scenarios(run["id"])
        self.expect(len(items) == 1, f"the subset run ran {len(items)} scenarios")
        verdict = items[0].get("verdict") or {}
        self.expect(verdict.get("status") == "pass", f"subset verdict {verdict}")
        return f"subset run {run['id']} passed the one scenario"

    def finding_resolved(self) -> str:
        finding = self.ok(self.client().get(f"/findings/{self.state.finding_id}"), 200)
        self.expect(
            finding["status"] == "resolved", f"finding status {finding['status']}"
        )
        return "finding resolved by the passing re-run"

    def cleanup(self) -> None:
        if not self.config.keep_target_defect:
            try:
                self.target.put(f"/qa/defects/{DEFECT}", json={"enabled": False})
            except httpx.HTTPError:
                pass
        if (
            self.state.personal_token_id
            and self.config.token_out is None
            and self.api is not None
        ):
            try:
                self.client().delete(f"/users/me/tokens/{self.state.personal_token_id}")
            except httpx.HTTPError:
                pass

    def run(self) -> int:
        steps: list[tuple[str, Callable[[], str]]] = [
            ("login", self.authenticate),
            ("dependencies", self.dependencies),
            ("create target", self.create_target),
            ("discovery prompt", self.discovery_prompt),
            ("upload bundle", self.upload_bundle),
            ("environment", self.set_environment),
            ("health checks", self.health_checks),
            ("catalog", self.read_catalog),
            ("approve oracles", self.approve_oracles),
            ("review scenarios", self.review_scenarios),
            ("seed reset", self.reset_seed),
            ("defect on", self.enable_defect),
            ("smoke plan", self.create_plan),
            ("suite run", self.start_suite_run),
            ("read run", self.read_suite_run),
            ("seed gate", self.seed_gate),
            ("oracle gold point", self.oracle_gold_point),
            ("expect_db", self.expect_db_check),
            ("judged step", self.judged_step),
            ("browser scenario", self.browser_scenario),
            ("finding and repro", self.finding_with_repro),
            ("explanation", self.post_explanation),
            ("personal token", self.mint_personal_token),
            ("flip target", self.flip_target),
            ("subset run", self.subset_run),
            ("finding resolved", self.finding_resolved),
        ]
        try:
            for name, action in steps:
                self.step(name, action)
        except SmokeFailure:
            self.summary(False)
            return 1
        except httpx.HTTPError as error:
            print(f"FAIL transport: {type(error).__name__}: {error}", flush=True)
            self.summary(False)
            return 1
        finally:
            self.cleanup()
        self.summary(True)
        return 0

    def summary(self, passed: bool) -> None:
        elapsed = time.monotonic() - self.started
        verdict = "PASSED" if passed else "FAILED"
        print(
            f"smoke {verdict}: {sum(1 for _, outcome, _ in self.results if outcome.startswith('ok'))} "
            f"of {len(self.results)} steps ok in {elapsed:.0f}s; target {self.state.target_id}, "
            f"suite run {self.state.suite_run_id}, subset run {self.state.subset_run_id}, "
            f"{self.state.feed_events} feed events",
            flush=True,
        )


def main() -> int:
    config = parse_arguments(sys.argv[1:])
    return Smoke(config).run()


if __name__ == "__main__":
    raise SystemExit(main())
