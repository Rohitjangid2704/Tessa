import { getBundle, uploadBundle, validateBundle } from "./bundles";
import { getCoverage } from "./coverage";
import type { ToolDefinition } from "./define";
import { getEnvironment, runHealthChecks, setEnvironment } from "./environment";
import { addExplanation, getFinding, listFindings, moveFinding } from "./findings";
import { inbox } from "./inbox";
import { issuePrompt } from "./prompts";
import { getProposal, planFromProposal, putProposal, updateProposalItem } from "./proposals";
import { cancelRun, getRun, getStep, runDiff, startRun, waitRun } from "./runs";
import { listScenarios, validateScenario } from "./scenarios";
import { getTarget, listTargets, whoami } from "./session";

export const TOOLS: ToolDefinition[] = [
  whoami,
  listTargets,
  getTarget,
  issuePrompt,
  validateBundle,
  uploadBundle,
  getBundle,
  getEnvironment,
  setEnvironment,
  runHealthChecks,
  startRun,
  waitRun,
  getRun,
  getStep,
  runDiff,
  cancelRun,
  listFindings,
  getFinding,
  addExplanation,
  moveFinding,
  getProposal,
  putProposal,
  updateProposalItem,
  planFromProposal,
  getCoverage,
  validateScenario,
  listScenarios,
  inbox,
];
