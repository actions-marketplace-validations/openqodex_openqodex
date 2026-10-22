// The briefs of the staged review (reviewer contract 2): one per finder
// session and one per verifier batch. Built by O4 of
// .private/plan-review-reasoning/PLAN.md; the signatures here are the
// contract the other builders code against, so they throw until built.
import type { Change, Config, ContextItem, FindPass, HunkRef, InstructionFile, ReviewUnit, RunTarget, ScanResult, SelectedLens, VerifyCandidate } from "./types.js";

// What every brief of a staged review shares with buildReviewerBrief: the
// change, the scan, the lenses, the config, the secrets and the owners'
// text. `impactBlock` is the graph's block; `neighbourhoodBlock` the
// "Code around the change" block the review package renders for the files
// in question (packages/review/src/neighbourhood.ts).
export type StagedBriefArgs = {
  change: Change;
  scan: ScanResult;
  lenses: SelectedLens[];
  config: Config;
  secrets: string[];
  impactBlock?: string;
  neighbourhoodBlock?: string;
  instructions?: string;
  instructionFiles?: readonly InstructionFile[];
  target?: RunTarget;
  confidenceFloor?: number;
  context?: readonly ContextItem[];
  instructionsFrom?: "repository" | "host";
};

// The lowest confidence a finder's candidate may have. The verifier decides
// what is kept; finalize's floor applies to the verifier's confidence.
export const FINDER_CONFIDENCE_FLOOR = 0.5;

// One verifier batch: the candidates of one file, at most VERIFY_BATCH_SIZE.
export type VerifyBatch = { file: string; hunks: HunkRef[]; candidates: VerifyCandidate[] };
export const VERIFY_BATCH_SIZE = 6;

// The brief of one finder session: the unit's hunks with their ids, the
// code around its files, the matched lenses, the pass's questions and the
// find answer shape (FindAnswer).
export function buildFindBrief(_args: StagedBriefArgs, _unit: ReviewUnit, _pass: FindPass): { text: string; diffFiles: Set<string> } {
  throw new Error("buildFindBrief is not built yet");
}

// The brief of one verifier session: that file's hunks with their ids, the
// code around the file, each candidate with its claim, evidence and the
// passes that raised it, the scanner candidates of the file, and the verdict
// shape (VerifyAnswer).
export function buildVerifyBrief(_args: StagedBriefArgs, _batch: VerifyBatch): { text: string } {
  throw new Error("buildVerifyBrief is not built yet");
}
