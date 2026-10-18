// Budget / confirmation gate (PLAN §6.3). Pure truth table, no I/O.
//
//   estimate > budget            -> needs-confirmation; `yes` does NOT override, only a bigger budget does
//   jobs > 1 and not yes         -> needs-confirmation (a batch always needs an explicit yes)
//   gpu != L4 and not (yes and an explicit rate) -> needs-confirmation
//   otherwise                    -> proceed

export const DEFAULT_BUDGET_CU = 1.0;
export const DEFAULT_GPU = "L4";

export interface GateInput {
  jobs: number;
  estimateCU: number;
  budgetCU: number;
  yes: boolean;
  gpu: string;
  rateExplicit: boolean;
}

export interface GateReason {
  code: "over-budget" | "batch-needs-yes" | "gpu-needs-rate";
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
    if (i.gpu !== DEFAULT_GPU && !(i.yes && i.rateExplicit)) {
      reasons.push({
        code: "gpu-needs-rate",
        message: `GPU ${i.gpu} is not the calibrated ${DEFAULT_GPU}`,
        hint: "pass --yes and an explicit --rate <CU per hour>",
      });
    }
  }
  return { decision: reasons.length ? "needs-confirmation" : "proceed", reasons };
}
