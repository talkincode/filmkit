// Budget / confirmation gate (PLAN §6.3). Pure truth table, no I/O.
//
//   estimate > budget            -> needs-confirmation; `yes` does NOT override, only a bigger budget does
//   jobs > 1 and not yes         -> needs-confirmation (a batch always needs an explicit yes)
//   uncalibrated gpu and not (yes and an explicit rate) -> needs-confirmation (gpu-needs-rate)
//   calibrated gpu other than L4 (A100) and not yes     -> needs-confirmation (gpu-needs-yes): A100/H100 always
//                                                          need the user's confirmation (Colab skill rule)
//   otherwise                    -> proceed

export const DEFAULT_BUDGET_CU = 1.0;
export const DEFAULT_GPU = "L4";
/** `--gpu auto` (the CLI default): L4 or A100, whichever the calibrated estimate says is cheaper. */
export const GPU_AUTO = "auto";

export interface GateInput {
  jobs: number;
  estimateCU: number;
  budgetCU: number;
  yes: boolean;
  gpu: string;
  rateExplicit: boolean;
  /** The GPU has its own entry in estimates.json (rate + timings). Default: gpu === L4. */
  calibrated?: boolean;
}

export interface GateReason {
  code: "over-budget" | "batch-needs-yes" | "gpu-needs-rate" | "gpu-needs-yes";
  message: string;
  hint: string;
}

export interface GateResult {
  decision: "proceed" | "needs-confirmation";
  reasons: GateReason[];
}

/** Smallest budget with one decimal that covers the estimate. */
export function suggestedBudget(estimateCU: number): number {
  return Math.ceil(estimateCU * 10 - 1e-9) / 10;
}

export function decide(i: GateInput): GateResult {
  const reasons: GateReason[] = [];
  if (i.jobs > 0) {
    if (i.estimateCU > i.budgetCU) {
      reasons.push({
        code: "over-budget",
        message: `estimate ${i.estimateCU.toFixed(2)} CU exceeds the budget ${i.budgetCU.toFixed(2)} CU`,
        hint: `--yes does not raise the budget; re-run with --budget ${suggestedBudget(i.estimateCU).toFixed(1)}`,
      });
    }
    if (i.jobs > 1 && !i.yes) {
      reasons.push({
        code: "batch-needs-yes",
        message: `${i.jobs} generation jobs in one session need explicit confirmation`,
        hint: "confirm with the user, then re-run with --yes",
      });
    }
    const calibrated = i.calibrated ?? i.gpu === DEFAULT_GPU;
    if (!calibrated && !(i.yes && i.rateExplicit)) {
      reasons.push({
        code: "gpu-needs-rate",
        message: `GPU ${i.gpu} has no calibration in estimates.json`,
        hint: "pass --yes and an explicit --rate <CU per hour>",
      });
    } else if (calibrated && i.gpu !== DEFAULT_GPU && !i.yes) {
      reasons.push({
        code: "gpu-needs-yes",
        message: `GPU ${i.gpu} costs more per hour than ${DEFAULT_GPU} and needs explicit confirmation`,
        hint: "confirm with the user, then re-run with --yes",
      });
    }
  }
  return { decision: reasons.length ? "needs-confirmation" : "proceed", reasons };
}
