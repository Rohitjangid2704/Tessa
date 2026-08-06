from enum import StrEnum


class UserRole(StrEnum):
    viewer = "viewer"
    member = "member"
    admin = "admin"


class RunKind(StrEnum):
    suite = "suite"
    seed = "seed"
    generate = "generate"
    explore = "explore"
    simulate = "simulate"
    redteam = "redteam"
    mutation = "mutation"
    hello = "hello"


class RunTrigger(StrEnum):
    manual = "manual"
    schedule = "schedule"
    api = "api"
    agent = "agent"


class RunStatus(StrEnum):
    queued = "queued"
    planning = "planning"
    seeding = "seeding"
    running = "running"
    canceling = "canceling"
    completed = "completed"
    failed = "failed"
    canceled = "canceled"
    budget_exceeded = "budget_exceeded"


class RunScenarioStatus(StrEnum):
    queued = "queued"
    running = "running"
    finished = "finished"
    skipped = "skipped"
    errored = "errored"
    canceled = "canceled"


class VerdictStatus(StrEnum):
    pass_ = "pass"
    fail = "fail"
    flaky = "flaky"
    uncertain = "uncertain"
    skipped = "skipped"


class VerdictTier(StrEnum):
    code = "code"
    laya = "laya"
    judge = "judge"
    human = "human"


class SkipReason(StrEnum):
    service_down = "service_down"
    hook_missing = "hook_missing"
    precondition_failed = "precondition_failed"
    env_missing = "env_missing"
    role_unavailable = "role_unavailable"
    budget_exceeded = "budget_exceeded"
    canceled = "canceled"
    production_blocked = "production_blocked"
    flag_disabled = "flag_disabled"
    quarantined = "quarantined"
    seed_mismatch = "seed_mismatch"
    adapter_unsupported = "adapter_unsupported"


class Confidence(StrEnum):
    low = "low"
    medium = "medium"
    high = "high"


class FeatureKind(StrEnum):
    read = "read"
    write = "write"
    flow = "flow"
    auth = "auth"
    admin = "admin"
    stream = "stream"
    job = "job"


class Depth(StrEnum):
    smoke = "smoke"
    standard = "standard"
    deep = "deep"


class InterfaceMode(StrEnum):
    api_only = "api_only"
    browser_only = "browser_only"
    both = "both"


class AdapterKind(StrEnum):
    http = "http"
    sse = "sse"
    websocket = "websocket"
    graphql = "graphql"
    browser = "browser"


class AppKind(StrEnum):
    web = "web"
    api = "api"
    llm_assistant = "llm_assistant"
    worker = "worker"
    cli = "cli"


class TargetTier(StrEnum):
    qa = "qa"
    production = "production"


class BundleSourceKind(StrEnum):
    zip = "zip"
    manifest_paste = "manifest_paste"


class BundleValidationStatus(StrEnum):
    valid = "valid"
    invalid = "invalid"


class BundleCompletenessStatus(StrEnum):
    below_bar = "below_bar"
    meets_bar = "meets_bar"


class BundleChange(StrEnum):
    added = "added"
    removed = "removed"
    changed = "changed"


class PromptTemplateName(StrEnum):
    discovery = "discovery"
    fixup = "fixup"
    explain = "explain"
    author = "author"
    hooks = "hooks"
    mutants = "mutants"
    propose = "propose"


class EnvVarKind(StrEnum):
    url = "url"
    dsn = "dsn"
    token = "token"
    password = "password"
    string = "string"
    number = "number"
    bool_ = "bool"


class HealthCheckStatus(StrEnum):
    unchecked = "unchecked"
    ok = "ok"
    failed = "failed"
    skipped = "skipped"


class ScenarioOrigin(StrEnum):
    bundle_example = "bundle_example"
    generated = "generated"
    authored = "authored"
    promoted_finding = "promoted_finding"
    explorer = "explorer"
    replay = "replay"
    manual = "manual"


class ScenarioStatus(StrEnum):
    draft = "draft"
    validating = "validating"
    invalid = "invalid"
    in_review = "in_review"
    accepted = "accepted"
    rejected = "rejected"
    quarantined = "quarantined"
    retired = "retired"


class CellStatus(StrEnum):
    empty = "empty"
    generated = "generated"
    covered = "covered"
    needs_author = "needs_author"
    blocked = "blocked"


class Tier0Check(StrEnum):
    status = "status"
    schema = "schema"
    fields = "fields"
    latency = "latency"
    tools = "tools"
    cards = "cards"
    internal_ids = "internal_ids"
    text_contains = "text_contains"
    text_not_contains = "text_not_contains"
    console = "console"
    dom_state = "dom_state"


class ArtifactKind(StrEnum):
    screenshot = "screenshot"
    recording = "recording"
    trace = "trace"
    report_html = "report_html"
    report_json = "report_json"


class ProbeStatus(StrEnum):
    decided = "decided"
    uncertain = "uncertain"
    error = "error"


class LabelSubjectType(StrEnum):
    probe_result = "probe_result"
    judge_result = "judge_result"
    invariant_result = "invariant_result"
    step = "step"


class LabelValue(StrEnum):
    pass_ = "pass"
    fail = "fail"
    uncertain = "uncertain"


class LabelSource(StrEnum):
    human = "human"
    judge_weak = "judge_weak"


class ModelRole(StrEnum):
    judge = "judge"
    judge_tiebreak = "judge_tiebreak"


class ModelCallRole(StrEnum):
    judge = "judge"
    judge_tiebreak = "judge_tiebreak"
    embed = "embed"


class ProbeEngine(StrEnum):
    laya = "laya"


class SyntheticFamily(StrEnum):
    invariant = "invariant"
    api_fuzz = "api_fuzz"
    exploration = "exploration"
    simulation = "simulation"
    redteam = "redteam"


class RunDiffCategory(StrEnum):
    new_failure = "new_failure"
    fixed = "fixed"
    still_failing = "still_failing"
    flaky_change = "flaky_change"
    unchanged = "unchanged"
    added = "added"
    removed = "removed"
    not_comparable = "not_comparable"


class SeedHashSource(StrEnum):
    bundle = "bundle"
    first_reset = "first_reset"


class Effort(StrEnum):
    minimal = "minimal"
    low = "low"
    medium = "medium"
    high = "high"


class Severity(StrEnum):
    critical = "critical"
    high = "high"
    medium = "medium"
    low = "low"
    info = "info"


class FindingStatus(StrEnum):
    new = "new"
    triaged = "triaged"
    in_fix = "in_fix"
    verifying = "verifying"
    resolved = "resolved"
    known_gap = "known_gap"
    dismissed = "dismissed"


class FindingClass(StrEnum):
    wrong_result = "wrong_result"
    invariant_violation = "invariant_violation"
    server_error = "server_error"
    security_boundary = "security_boundary"
    safety_claim = "safety_claim"
    performance = "performance"
    accessibility = "accessibility"
    flaky = "flaky"
    contract = "contract"
    harness = "harness"


class InvariantPack(StrEnum):
    generic = "generic"
    llm_app = "llm_app"
    target = "target"


class BuiltInInvariantId(StrEnum):
    no_5xx = "no_5xx"
    no_console_errors = "no_console_errors"
    auth_boundaries = "auth_boundaries"
    role_monotonicity = "role_monotonicity"
    tenant_isolation = "tenant_isolation"
    idempotent_writes = "idempotent_writes"
    pii_by_role = "pii_by_role"
    accessibility = "accessibility"
    latency = "latency"
    no_save_claim_before_confirm = "no_save_claim_before_confirm"
    no_internal_ids = "no_internal_ids"
    external_facts_labelled = "external_facts_labelled"
    refuses_out_of_scope = "refuses_out_of_scope"
    injection_resistance = "injection_resistance"
    authority_pressure = "authority_pressure"
    count_consistency = "count_consistency"
    empty_set_honesty = "empty_set_honesty"


class InvariantCheck(StrEnum):
    code = "code"
    probe = "probe"
    oracle = "oracle"
    db = "db"


class ModelCallStatus(StrEnum):
    ok = "ok"
    error = "error"
    invalid_output = "invalid_output"
    budget_blocked = "budget_blocked"


class ExplanationSource(StrEnum):
    claude_code = "claude_code"


class TrendMetric(StrEnum):
    pass_hat_k = "pass_hat_k"
    open_findings = "open_findings"
    cost_usd = "cost_usd"
    latency_p50_ms = "latency_p50_ms"
    flaky_rate = "flaky_rate"


class DedupeMode(StrEnum):
    embedding = "embedding"
    exact_only = "exact_only"


class ReviewDecision(StrEnum):
    accept = "accept"
    reject = "reject"


class ScenarioPatchStatus(StrEnum):
    retired = "retired"
    quarantined = "quarantined"
    accepted = "accepted"


class CoverageUpdateReason(StrEnum):
    generated = "generated"
    run = "run"
    review = "review"


class GenerationVariant(StrEnum):
    paraphrase = "paraphrase"
    negative = "negative"
    role_variant = "role_variant"
    adversarial = "adversarial"


class OracleApproval(StrEnum):
    unreviewed = "unreviewed"
    approved = "approved"
    rejected = "rejected"


class OracleResultStatus(StrEnum):
    pending = "pending"
    ok = "ok"
    error = "error"


class AttackOutcome(StrEnum):
    blocked = "blocked"
    breached = "breached"
    inconclusive = "inconclusive"


class MutationOutcome(StrEnum):
    killed = "killed"
    survived = "survived"
    errored = "errored"
    skipped = "skipped"


class MutantStatus(StrEnum):
    registered = "registered"
    deployed = "deployed"
    retired = "retired"


class CalibrationKind(StrEnum):
    probe = "probe"
    judge = "judge"


class ReportChannel(StrEnum):
    slack = "slack"


class ScheduleTier(StrEnum):
    commit = "commit"
    nightly = "nightly"
    weekly = "weekly"


class NotificationKind(StrEnum):
    run_finished = "run_finished"
    nightly_summary = "nightly_summary"
    finding_regression = "finding_regression"
    budget_exceeded = "budget_exceeded"
    mutant_survived = "mutant_survived"
    schedule_failed = "schedule_failed"


class FeedName(StrEnum):
    runs = "runs"
    home = "home"
    coverage = "coverage"
    findings = "findings"


class BrowserSessionStatus(StrEnum):
    active = "active"
    ended = "ended"


class GoalKind(StrEnum):
    reach_state = "reach_state"
    extract_fact = "extract_fact"
    attempt_forbidden = "attempt_forbidden"
    complete_flow = "complete_flow"


class CriterionKind(StrEnum):
    db = "db"
    tool = "tool"
    text = "text"
    judge = "judge"


class ExploreActionKind(StrEnum):
    navigate = "navigate"
    click = "click"
    type = "type"
    read = "read"
    finish = "finish"


class CandidateSource(StrEnum):
    detector = "detector"
    model_claim = "model_claim"


class CandidateStatus(StrEnum):
    pending = "pending"
    verified = "verified"
    unverified = "unverified"
    discarded = "discarded"


class SimSpeaker(StrEnum):
    persona = "persona"
    target = "target"


class SimCheck(StrEnum):
    end_state = "end_state"
    calls = "calls"
    invariants = "invariants"
    goal = "goal"
    dialogue = "dialogue"


class RedTeamFamily(StrEnum):
    prompt_injection = "prompt_injection"
    authority_pressure = "authority_pressure"
    internal_id_extraction = "internal_id_extraction"
    role_escalation = "role_escalation"
    data_exfiltration = "data_exfiltration"
    unconfirmed_write = "unconfirmed_write"
    out_of_scope = "out_of_scope"


class TraitLevel(StrEnum):
    low = "low"
    medium = "medium"
    high = "high"


class PersonaTone(StrEnum):
    formal = "formal"
    casual = "casual"
    terse = "terse"
    friendly = "friendly"
    impatient = "impatient"


class DependencyStatus(StrEnum):
    up = "up"
    down = "down"
    unconfigured = "unconfigured"


class SeedResetStatus(StrEnum):
    ok = "ok"
    failed = "failed"
    mismatch = "mismatch"


class SeedPhase(StrEnum):
    reset = "reset"
    hash = "hash"
    assert_ = "assert"


class SeedPhaseStatus(StrEnum):
    started = "started"
    ok = "ok"
    failed = "failed"


class SeedAction(StrEnum):
    verify = "verify"
    reset = "reset"


class OracleLanguage(StrEnum):
    sql = "sql"
    python = "python"


class ProbeSource(StrEnum):
    generic = "generic"
    llm_app = "llm_app"
    target = "target"


class ProbeAnswerType(StrEnum):
    yes_no = "yes_no"
    choice = "choice"


class ProbeInputField(StrEnum):
    ask = "ask"
    answer = "answer"
    tool_names = "tool_names"
    card_titles = "card_titles"
    invariant_rule = "invariant_rule"


class JudgeFamily(StrEnum):
    openai = "openai"
    anthropic = "anthropic"


class JudgeOrder(StrEnum):
    a_b = "a_b"
    b_a = "b_a"


class LabelReason(StrEnum):
    uncertain = "uncertain"
    judge_flagged = "judge_flagged"
    disagreement = "disagreement"
    audit = "audit"


class SettingSource(StrEnum):
    env = "env"
    db = "db"


class SecretName(StrEnum):
    openai_api_key = "openai_api_key"
    anthropic_api_key = "anthropic_api_key"
    slack_webhook_url = "slack_webhook_url"


class ServiceName(StrEnum):
    laya = "laya"
    openai = "openai"
    anthropic = "anthropic"
    temporal = "temporal"
    slack = "slack"


class AuditAction(StrEnum):
    user_created = "user_created"
    user_role_changed = "user_role_changed"
    user_active_changed = "user_active_changed"
    sso_user_provisioned = "sso_user_provisioned"
    team_created = "team_created"
    team_renamed = "team_renamed"
    team_members_changed = "team_members_changed"
    team_budget_set = "team_budget_set"
    target_team_changed = "target_team_changed"
    retention_policy_changed = "retention_policy_changed"
    secret_set = "secret_set"
    secret_deleted = "secret_deleted"
    allow_production_changed = "allow_production_changed"
    token_created = "token_created"
    token_revoked = "token_revoked"
    personal_token_write = "personal_token_write"
    proposal_put = "proposal_put"
    proposal_item_changed = "proposal_item_changed"


class AuditSubjectType(StrEnum):
    user = "user"
    team = "team"
    target = "target"
    secret = "secret"
    retention = "retention"
    personal_token = "personal_token"
    route = "route"
    proposal = "proposal"


class AuditVia(StrEnum):
    web = "web"
    mcp = "mcp"
    svc = "svc"


class ProposalKind(StrEnum):
    api = "api"
    browser = "browser"
    stream = "stream"
    webhook = "webhook"
    pipeline = "pipeline"
    contract = "contract"
    integration = "integration"


class ProposalRisk(StrEnum):
    high = "high"
    medium = "medium"
    low = "low"


class ProposalReason(StrEnum):
    recent_change = "recent_change"
    no_unit_tests = "no_unit_tests"
    auth_path = "auth_path"
    money_path = "money_path"
    migration = "migration"
    complexity = "complexity"
    bug_history = "bug_history"
    external_dependency = "external_dependency"
    user_visible = "user_visible"


class ProposalNeed(StrEnum):
    seed = "seed"
    db_read = "db_read"
    hook = "hook"
    flag = "flag"
    fixture = "fixture"
    credentials = "credentials"


class ProposalItemStatus(StrEnum):
    proposed = "proposed"
    selected = "selected"
    declined = "declined"
    authored = "authored"
    covered = "covered"


class ProposalItemChoice(StrEnum):
    proposed = "proposed"
    selected = "selected"
    declined = "declined"


class ProposalOrigin(StrEnum):
    bundle = "bundle"
    put = "put"


class ExplanationOpinion(StrEnum):
    app_bug = "app_bug"
    scenario_bug = "scenario_bug"
    harness = "harness"
    unknown = "unknown"
