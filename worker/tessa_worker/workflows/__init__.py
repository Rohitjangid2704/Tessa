from tessa_worker.workflows.build_report import BuildReportWorkflow
from tessa_worker.workflows.execute_run import ExecuteRunWorkflow
from tessa_worker.workflows.fuzz_family import FuzzFamilyWorkflow
from tessa_worker.workflows.grade_step import GradeStepWorkflow
from tessa_worker.workflows.hello import HelloWorkflow
from tessa_worker.workflows.mutation_run import MutationRunWorkflow
from tessa_worker.workflows.plan_coverage import PlanCoverageWorkflow
from tessa_worker.workflows.redteam_attack import AttackPipelineWorkflow
from tessa_worker.workflows.retention_sweep import RetentionSweepWorkflow
from tessa_worker.workflows.run_oracle import RunOracleWorkflow
from tessa_worker.workflows.run_scenario import RunScenarioWorkflow
from tessa_worker.workflows.scheduled_run import ScheduledRunWorkflow
from tessa_worker.workflows.seed_target import SeedTargetWorkflow
from tessa_worker.workflows.triage_findings import TriageFindingsWorkflow

WORKFLOWS = [
    HelloWorkflow,
    ExecuteRunWorkflow,
    RunScenarioWorkflow,
    PlanCoverageWorkflow,
    SeedTargetWorkflow,
    RunOracleWorkflow,
    GradeStepWorkflow,
    TriageFindingsWorkflow,
    BuildReportWorkflow,
    ScheduledRunWorkflow,
    MutationRunWorkflow,
    FuzzFamilyWorkflow,
    AttackPipelineWorkflow,
    RetentionSweepWorkflow,
]
