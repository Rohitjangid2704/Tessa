import "../stage2/seed";
import { artifactHandlers } from "./artifacts";
import { agentSessionHandlers } from "./agent-sessions";
import { auditEventHandlers } from "./audit-events";
import { authHandlers } from "./auth";
import { authorPromptHandlers } from "./author-prompt";
import { bundleHandlers } from "./bundles";
import { bundleValidateHandlers } from "./bundle-validate";
import { bundleSourceHandlers } from "./bundle-source";
import { calibrationHandlers } from "./calibration";
import { catalogHandlers } from "./catalog";
import { contractControlHandlers } from "./contracts-control";
import { contractHandlers } from "./contracts";
import { coverageControlHandlers } from "./coverage-control";
import { coverageHandlers } from "./coverage";
import { dashboardHandlers } from "./dashboard";
import { environmentHandlers } from "./environment";
import { exploreHandlers } from "./explore";
import { findingDetailHandlers } from "./finding-detail";
import { findingHandlers } from "./findings";
import { frameRunHandlers } from "./frame-runs";
import { goalHandlers } from "./goals";
import { invariantHandlers } from "./invariants";
import { labelHandlers } from "./labels";
import { libraryHandlers } from "./library";
import { limitsHandlers } from "./limits";
import { mockControlHandlers } from "./mock-control";
import { mutationHandlers } from "./mutation";
import { mutationPromptHandlers } from "./mutation-prompt";
import { notificationHandlers } from "./notifications";
import { oracleHandlers } from "./oracle";
import { personaHandlers } from "./personas";
import { personalTokenHandlers } from "./personal-tokens";
import { planHandlers } from "./plans";
import { probeHandlers } from "./probes";
import { promptHandlers } from "./prompts";
import { proposalHandlers } from "./proposals";
import { redteamHandlers } from "./redteam";
import { replayHandlers } from "./replay";
import { reportHandlers } from "./report";
import { runGroupHandlers } from "./run-groups";
import { runStatsHandlers } from "./run-stats";
import { runHandlers } from "./runs";
import { scenarioEditHandlers } from "./scenario-edit";
import { scenarioHandlers } from "./scenarios";
import { scheduleControlHandlers } from "./schedules-control";
import { scheduleHandlers } from "./schedules";
import { schemaHandlers } from "./schemas";
import { seedHandlers } from "./seeds";
import { settingsHandlers } from "./settings";
import { simControlHandlers } from "./sim-control";
import { simHandlers } from "./sim";
import { stageFiveControlHandlers } from "./stage5-control";
import { stageEightControlHandlers } from "./stage8-control";
import { stageFourControlHandlers } from "./stage4-control";
import { stageOneControlHandlers } from "./stage1-control";
import { stageNineControlHandlers } from "./stage9-control";
import { stageElevenControlHandlers } from "./stage11-control";
import { stageTenControlHandlers } from "./stage10-control";
import { stageSevenControlHandlers } from "./stage7-control";
import { stageThreeControlHandlers } from "./stage3-control";
import { stageTwoControlHandlers } from "./stage2-control";
import { stepHandlers } from "./steps";
import { systemHandlers } from "./system";
import { targetHandlers } from "./targets";
import { trendHandlers } from "./trends";
import { retentionHandlers } from "./retention";
import { teamHandlers } from "./teams";
import { calibrationFitHandlers } from "./calibration-fit";
import { labelsExportHandlers } from "./labels-export";
import { liveProbesHandlers } from "./live-probes";
import { userHandlers } from "./users";
import { rbacControlHandlers } from "./rbac-control";

export const handlers = [
  ...environmentHandlers,
  ...targetHandlers,
  ...limitsHandlers,
  ...findingDetailHandlers,
  ...authorPromptHandlers,
  ...mutationPromptHandlers,
  ...promptHandlers,
  ...bundleHandlers,
  ...catalogHandlers,
  ...systemHandlers,
  ...schemaHandlers,
  ...authHandlers,
  ...runHandlers,
  ...planHandlers,
  ...scenarioHandlers,
  ...scenarioEditHandlers,
  ...stepHandlers,
  ...artifactHandlers,
  ...mockControlHandlers,
  ...stageOneControlHandlers,
  ...stageTwoControlHandlers,
  ...oracleHandlers,
  ...seedHandlers,
  ...stageThreeControlHandlers,
  ...probeHandlers,
  ...labelHandlers,
  ...settingsHandlers,
  ...stageFourControlHandlers,
  ...findingHandlers,
  ...stageFiveControlHandlers,
  ...coverageHandlers,
  ...coverageControlHandlers,
  ...invariantHandlers,
  ...runStatsHandlers,
  ...trendHandlers,
  ...exploreHandlers,
  ...stageSevenControlHandlers,
  ...redteamHandlers,
  ...replayHandlers,
  ...scheduleHandlers,
  ...scheduleControlHandlers,
  ...personaHandlers,
  ...goalHandlers,
  ...simHandlers,
  ...simControlHandlers,
  ...dashboardHandlers,
  ...calibrationHandlers,
  ...notificationHandlers,
  ...reportHandlers,
  ...stageEightControlHandlers,
  ...frameRunHandlers,
  ...mutationHandlers,
  ...runGroupHandlers,
  ...stageNineControlHandlers,
  ...contractHandlers,
  ...contractControlHandlers,
  ...libraryHandlers,
  ...bundleSourceHandlers,
  ...stageTenControlHandlers,
  ...userHandlers,
  ...retentionHandlers,
  ...teamHandlers,
  ...labelsExportHandlers,
  ...calibrationFitHandlers,
  ...liveProbesHandlers,
  ...rbacControlHandlers,
  ...personalTokenHandlers,
  ...bundleValidateHandlers,
  ...agentSessionHandlers,
  ...auditEventHandlers,
  ...proposalHandlers,
  ...stageElevenControlHandlers,
];

export { mockState } from "../state";
