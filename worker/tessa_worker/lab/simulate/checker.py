import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from temporalio.exceptions import ApplicationError

from tessa_api.db.models import SimSessionRow
from tessa_api.db.session import SessionFactory
from tessa_api.schemas.common import Verdict
from tessa_api.schemas.enums import InvariantPack, ModelRole, VerdictStatus, VerdictTier
from tessa_api.schemas.invariants import InvariantResult
from tessa_api.schemas.oracles import DbCheck
from tessa_api.schemas.sim import SimChecks
from tessa_api.schemas.streams import SimCheckedPayload
from tessa_api.schemas.temporal import (
    CheckSimulationInput,
    CheckSimulationResult,
    EvaluateInvariantsInput,
    InvariantResultBatch,
)
from tessa_api.services.goal_criteria import (
    CriterionProblem,
    DbCriterion,
    JudgeCriterion,
    ParsedCriterion,
    TextCriterion,
    ToolCriterion,
    criterion_problems,
)
from tessa_api.services.settings_service import effective_settings, model_call_spec
from tessa_api.services.smoke_generator import truncated
from tessa_worker.event_client import EventClient, build_event
from tessa_worker.grading.judge_runner import JudgeRunner
from tessa_worker.lab.simulate.criteria_checks import text_outcome, tool_outcome
from tessa_worker.lab.simulate.judging import (
    CRITERION_RULE_ID,
    CriterionRule,
    JudgedOutcome,
    JudgeRequest,
    JudgeUsage,
    SessionJudge,
)
from tessa_worker.lab.simulate.outcomes import (
    NO_CRITERIA,
    CheckOutcome,
    failed,
    merge_outcomes,
    passed,
    skipped,
    uncertain,
)
from tessa_worker.lab.simulate.rubrics import CRITERION_RUBRIC, DIALOGUE_RUBRIC
from tessa_worker.lab.simulate.session_record import SessionRecord, load_session_record
from tessa_worker.lab.simulate.transcripts import target_replies
from tessa_worker.lab.simulate.verdict import CheckOutcomes, combine_checks
from tessa_worker.settings import WorkerSettings
from tessa_worker.truth.step_checks import DbCheckOutcome, StepChecks

logger = logging.getLogger("tessa_worker.simulator.checker")

EvaluateInvariants = Callable[[EvaluateInvariantsInput], Awaitable[InvariantResultBatch]]

NO_TURNS = "sim_no_turns"
TURN_NOT_COMPLETED = "turn_not_completed"
TURNS_COMPLETED = "turns_completed"
CRITERION_MALFORMED = "criterion_malformed"
INVARIANTS_UNAVAILABLE = "invariants_unavailable"
INVARIANTS_HOLD = "invariants_hold"
INVARIANTS_NOT_APPLICABLE = "invariants_not_applicable"
EXTERNAL_JUDGES_FORBIDDEN = "external_judges_forbidden"
DB_CHECK_PASSED = "db_check_passed"
DB_CHECK_FAILED = "db_check_failed"
DB_CHECK_UNDECIDED = "db_check_undecided"
DB_CHECK_SKIPPED = "db_check_skipped"
NO_END_STATE_CRITERIA = "no_end_state_criteria"
MESSAGE_LIMIT = 200
GOAL_LABEL_PREVIEW = 100


@dataclass(frozen=True, slots=True)
class CheckerDependencies:
    settings: WorkerSettings
    session_factory: SessionFactory
    events: EventClient
    checks: StepChecks
    evaluate_invariants: EvaluateInvariants
    judge_runner: JudgeRunner


@dataclass(slots=True)
class CriterionRun:
    outcomes: list[CheckOutcome] = field(default_factory=list)
    db_outcomes: list[CheckOutcome] = field(default_factory=list)
    tool_outcomes: list[CheckOutcome] = field(default_factory=list)
    db_checks: list[DbCheck] = field(default_factory=list)
    usage: JudgeUsage = field(default_factory=JudgeUsage)
    judged: int = 0


def no_turn_outcomes() -> CheckOutcomes:
    nothing = skipped("the session sent no message to the target", NO_TURNS)
    return CheckOutcomes(
        end_state=nothing,
        calls=uncertain(VerdictTier.code, "the session never reached the target", NO_TURNS),
        invariants=nothing,
        goal=uncertain(VerdictTier.code, "no turn was sent, so no criterion was tested", NO_TURNS),
        dialogue=nothing,
    )


def completion_outcome(record: SessionRecord) -> CheckOutcome:
    broken = next((step for step in record.turn_steps if step.ok is False), None)
    if broken is not None:
        detail = broken.error or "no detail was reported"
        return failed(
            VerdictTier.code,
            f"turn {broken.index + 1} did not complete: {detail}"[:MESSAGE_LIMIT],
            TURN_NOT_COMPLETED,
        )
    if len(record.turn_steps) < record.target_turns:
        return failed(
            VerdictTier.code, "a turn failed before the target answered", TURN_NOT_COMPLETED
        )
    return passed(VerdictTier.code, f"{record.target_turns} turns completed", TURNS_COMPLETED, 1.0)


def invariant_outcome(result: InvariantResult) -> CheckOutcome:
    message = f"{result.invariant_id}: {result.message}"[:MESSAGE_LIMIT]
    match result.status:
        case VerdictStatus.fail:
            return failed(result.tier, message, result.invariant_id)
        case VerdictStatus.uncertain:
            return uncertain(result.tier, message, result.invariant_id, result.confidence)
        case VerdictStatus.pass_:
            return passed(result.tier, message, result.invariant_id, result.confidence)
        case _:
            return skipped(message, result.invariant_id)


def invariants_summary(results: list[InvariantResult]) -> CheckOutcome:
    outcomes = [invariant_outcome(result) for result in results]
    for status in (VerdictStatus.fail, VerdictStatus.uncertain):
        found = next((outcome for outcome in outcomes if outcome.status is status), None)
        if found is not None:
            return found
    holding = [outcome for outcome in outcomes if outcome.status is VerdictStatus.pass_]
    if not holding:
        return skipped("no invariant applied to the session", INVARIANTS_NOT_APPLICABLE)
    return passed(VerdictTier.code, f"{len(holding)} invariants hold", INVARIANTS_HOLD, 1.0)


def failing_db_check(checks: list[DbCheck]) -> str | None:
    broken = next((check for check in checks if check.status is not VerdictStatus.pass_), None)
    if broken is None:
        return None
    return f"{broken.name}: expected {broken.expected}, got {broken.actual}"


def db_outcome(criterion: DbCriterion, result: DbCheckOutcome) -> CheckOutcome:
    oracle = criterion.check.oracle
    verdict = result.verdict
    detail = verdict.reason or failing_db_check(result.db_checks) or "no detail was reported"
    message = f"oracle {oracle}: {detail}"[:MESSAGE_LIMIT]
    match verdict.status:
        case VerdictStatus.pass_:
            return passed(
                VerdictTier.code,
                f"oracle {oracle} matches the expectation",
                DB_CHECK_PASSED,
                1.0,
            )
        case VerdictStatus.fail:
            return failed(VerdictTier.code, message, DB_CHECK_FAILED)
        case VerdictStatus.skipped:
            return skipped(message, DB_CHECK_SKIPPED)
        case _:
            return uncertain(VerdictTier.code, message, DB_CHECK_UNDECIDED)


def malformed_outcome(problem: CriterionProblem, source: str) -> CheckOutcome:
    return uncertain(
        VerdictTier.code,
        f"the criterion {truncated(source, GOAL_LABEL_PREVIEW)!r} is malformed: {problem.message}",
        CRITERION_MALFORMED,
    )


def goal_problem_outcomes(
    problems: list[CriterionProblem], criteria: list[str]
) -> list[CheckOutcome]:
    return [malformed_outcome(problem, criteria[problem.index]) for problem in problems]


class SimulationChecker:
    def __init__(self, dependencies: CheckerDependencies) -> None:
        self.dependencies = dependencies

    async def check(self, request: CheckSimulationInput) -> CheckSimulationResult:
        record = await load_session_record(
            self.dependencies.session_factory, request.sim_session_id
        )
        usage = JudgeUsage()
        if record.target_turns == 0:
            outcomes = no_turn_outcomes()
        else:
            outcomes, usage = await self.evaluate(record)
        verdict = combine_checks(outcomes)
        checks = outcomes.statuses()
        await self.persist(record, checks, verdict)
        return CheckSimulationResult(
            cost_usd=usage.cost_usd,
            input_tokens=usage.input_tokens,
            output_tokens=usage.output_tokens,
            checks=checks,
            verdict=verdict,
        )

    async def evaluate(self, record: SessionRecord) -> tuple[CheckOutcomes, JudgeUsage]:
        parsed, problems = criterion_problems(record.criteria)
        invariants = await self.invariants_outcome(record)
        judge = await self.session_judge()
        run = await self.run_criteria(record, parsed, judge)
        run.outcomes.extend(goal_problem_outcomes(problems, list(record.criteria)))
        dialogue = await self.dialogue_outcome(record, judge, run)
        completion = completion_outcome(record)
        calls = merge_outcomes([completion, *run.tool_outcomes], completion)
        outcomes = CheckOutcomes(
            end_state=merge_outcomes(
                run.db_outcomes,
                skipped("the goal declares no db: criterion", NO_END_STATE_CRITERIA),
            ),
            calls=calls,
            invariants=invariants,
            goal=merge_outcomes(
                run.outcomes,
                uncertain(VerdictTier.code, "the goal declares no success criteria", NO_CRITERIA),
            ),
            dialogue=dialogue,
        )
        return outcomes, run.usage

    async def session_judge(self) -> SessionJudge:
        async with self.dependencies.session_factory() as session:
            effective = await effective_settings(session, self.dependencies.settings)
        return SessionJudge(
            self.dependencies.judge_runner,
            self.dependencies.session_factory,
            model_call_spec(ModelRole.judge, effective),
        )

    async def invariants_outcome(self, record: SessionRecord) -> CheckOutcome:
        try:
            batch = await self.dependencies.evaluate_invariants(
                EvaluateInvariantsInput(
                    run_id=record.run_id,
                    run_scenario_id=record.run_scenario_id,
                    attempt=record.attempt,
                    pack_ids=list(InvariantPack),
                )
            )
        except ApplicationError as error:
            return uncertain(
                VerdictTier.code,
                f"the invariants could not be evaluated: {error}"[:MESSAGE_LIMIT],
                INVARIANTS_UNAVAILABLE,
            )
        return invariants_summary(batch.results)

    async def run_criteria(
        self, record: SessionRecord, parsed: list[ParsedCriterion], judge: SessionJudge
    ) -> CriterionRun:
        run = CriterionRun()
        replies = target_replies(record.transcript)
        tools = [tool for step in record.turn_steps for tool in step.tools]
        for criterion in parsed:
            match criterion:
                case TextCriterion():
                    run.outcomes.append(text_outcome(criterion, replies))
                case ToolCriterion():
                    outcome = tool_outcome(criterion, tools)
                    run.tool_outcomes.append(outcome)
                    run.outcomes.append(outcome)
                case DbCriterion():
                    await self.run_db(record, criterion, run)
                case JudgeCriterion():
                    await self.run_judge(record, criterion, judge, run)
        await self.store_db_checks(record, run.db_checks)
        return run

    async def run_db(
        self, record: SessionRecord, criterion: DbCriterion, run: CriterionRun
    ) -> None:
        scope = await self.dependencies.checks.load_scope(record.run_id, record.run_scenario_id)
        result = await self.dependencies.checks.check_db(scope, criterion.check, {})
        outcome = db_outcome(criterion, result)
        run.db_checks.extend(result.db_checks)
        run.db_outcomes.append(outcome)
        run.outcomes.append(outcome)

    async def store_db_checks(self, record: SessionRecord, checks: list[DbCheck]) -> None:
        if checks and record.turn_steps:
            await self.dependencies.checks.store_db_checks(record.turn_steps[-1].step_id, checks)

    async def run_judge(
        self,
        record: SessionRecord,
        criterion: JudgeCriterion,
        judge: SessionJudge,
        run: CriterionRun,
    ) -> None:
        if not record.judges_allowed:
            run.outcomes.append(
                skipped(
                    f"the target forbids external judges: {truncated(criterion.statement, 80)}",
                    EXTERNAL_JUDGES_FORBIDDEN,
                )
            )
            return
        judged = await judge.judge(
            record,
            JudgeRequest(
                index=run.judged,
                label=f"Judge goal: {truncated(criterion.statement, GOAL_LABEL_PREVIEW)}",
                rubric=CRITERION_RUBRIC,
                rules=[CriterionRule(CRITERION_RULE_ID, criterion.statement)],
            ),
        )
        self.absorb(run, judged)

    def absorb(self, run: CriterionRun, judged: JudgedOutcome) -> None:
        run.judged += 1
        run.usage = run.usage.plus(judged.usage)
        run.outcomes.append(judged.outcome)

    async def dialogue_outcome(
        self, record: SessionRecord, judge: SessionJudge, run: CriterionRun
    ) -> CheckOutcome:
        if not record.judges_allowed:
            return skipped("the target forbids external judges", EXTERNAL_JUDGES_FORBIDDEN)
        judged = await judge.judge(
            record,
            JudgeRequest(
                index=run.judged,
                label="Judge dialogue",
                rubric=DIALOGUE_RUBRIC,
                rules=[],
            ),
        )
        run.judged += 1
        run.usage = run.usage.plus(judged.usage)
        return judged.outcome

    async def persist(self, record: SessionRecord, checks: SimChecks, verdict: Verdict) -> None:
        async with self.dependencies.session_factory() as session:
            row = await session.get(SimSessionRow, record.sim_session_id, with_for_update=True)
            if row is None:
                return
            row.checks = checks.model_dump(mode="json")
            row.verdict = verdict.model_dump(mode="json")
            await session.commit()
        await self.dependencies.events.deliver(
            [
                build_event(
                    record.run_id,
                    "sim.checked",
                    SimCheckedPayload(
                        sim_session_id=record.sim_session_id, checks=checks, verdict=verdict
                    ),
                    f"sim.checked:{record.sim_session_id}",
                )
            ]
        )
