from temporalio import activity

from tessa_api.db.session import SessionFactory
from tessa_api.schemas.temporal import (
    SKEPTIC_VERIFY_ACTIVITY,
    SkepticVerifyInput,
    SkepticVerifyOutput,
)
from tessa_worker.activities.judge import JudgeActivities
from tessa_worker.activities.redteam_models import (
    ASSESS_ATTACK,
    PREPARE_ATTACK,
    PREPARE_ATTACK_REPLAYS,
    SETTLE_ATTACK,
    AssessAttackInput,
    AttackAssessment,
    PrepareAttackInput,
    PrepareAttackReplaysInput,
    PreparedAttack,
    PreparedReplays,
    SettleAttackInput,
    SettleAttackResult,
)
from tessa_worker.event_client import EventClient
from tessa_worker.invariants.contracts import ProbeRunner
from tessa_worker.lab.redteam.assessment import assess_attack
from tessa_worker.lab.redteam.skeptic import JudgeSkeptic
from tessa_worker.lab.redteam.store import (
    prepare_attack,
    prepare_replays,
    record_attack,
    settle_attack,
)
from tessa_worker.settings import WorkerSettings


class RedTeamActivities:
    def __init__(
        self,
        settings: WorkerSettings,
        session_factory: SessionFactory,
        events: EventClient,
        probes: ProbeRunner,
        skeptic: JudgeSkeptic,
    ) -> None:
        self.settings = settings
        self.session_factory = session_factory
        self.events = events
        self.probes = probes
        self.skeptic = skeptic

    @activity.defn(name=PREPARE_ATTACK)
    async def prepare_attack(self, request: PrepareAttackInput) -> PreparedAttack:
        async with self.session_factory() as session:
            prepared, events = await prepare_attack(session, self.settings, request)
        await self.events.deliver_all(events)
        return prepared

    @activity.defn(name=ASSESS_ATTACK)
    async def assess_attack(self, request: AssessAttackInput) -> AttackAssessment:
        assessment = await assess_attack(self.session_factory, self.settings, self.probes, request)
        if request.record:
            async with self.session_factory() as session:
                await record_attack(session, request, assessment)
        return assessment

    @activity.defn(name=PREPARE_ATTACK_REPLAYS)
    async def prepare_attack_replays(self, request: PrepareAttackReplaysInput) -> PreparedReplays:
        async with self.session_factory() as session:
            prepared, events = await prepare_replays(session, self.settings, request)
        await self.events.deliver_all(events)
        return prepared

    @activity.defn(name=SKEPTIC_VERIFY_ACTIVITY)
    async def skeptic_verify(self, request: SkepticVerifyInput) -> SkepticVerifyOutput:
        return await self.skeptic.verify(request)

    @activity.defn(name=SETTLE_ATTACK)
    async def settle_attack(self, request: SettleAttackInput) -> SettleAttackResult:
        async with self.session_factory() as session:
            finding_id, events = await settle_attack(session, self.settings, request)
        await self.events.deliver_all(events)
        return SettleAttackResult(finding_id=finding_id)


def default_redteam_activities(
    settings: WorkerSettings,
    session_factory: SessionFactory,
    events: EventClient,
    probes: ProbeRunner,
    judge: JudgeActivities,
) -> RedTeamActivities:
    return RedTeamActivities(
        settings,
        session_factory,
        events,
        probes,
        JudgeSkeptic(settings, session_factory, judge.runner),
    )
