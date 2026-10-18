import { describe, expect, test } from "bun:test";
import { decide, suggestedBudget, type GateInput } from "../src/gate.ts";

const base: GateInput = { jobs: 1, estimateCU: 0.54, budgetCU: 1.0, yes: false, gpu: "L4", rateExplicit: false };
const codes = (i: Partial<GateInput>): string[] => decide({ ...base, ...i }).reasons.map((r) => r.code);

describe("gate truth table (PLAN §6.3)", () => {
  // [name, overrides, expected decision, expected reason codes]
  const rows: [string, Partial<GateInput>, "proceed" | "needs-confirmation", string[]][] = [
    ["single job under budget, no --yes", {}, "proceed", []],
    ["single job under budget, --yes", { yes: true }, "proceed", []],
    ["batch of 3 under budget, no --yes", { jobs: 3, estimateCU: 0.77 }, "needs-confirmation", ["batch-needs-yes"]],
    ["batch of 3 under budget, --yes", { jobs: 3, estimateCU: 0.77, yes: true }, "proceed", []],
    ["over budget, no --yes", { estimateCU: 1.2 }, "needs-confirmation", ["over-budget"]],
    ["over budget, --yes does NOT override", { estimateCU: 1.2, yes: true }, "needs-confirmation", ["over-budget"]],
    ["over budget, raised budget", { estimateCU: 1.2, budgetCU: 1.3 }, "proceed", []],
    ["exactly at budget", { estimateCU: 1.0 }, "proceed", []],
    ["over budget and batch, no --yes: both reasons", { jobs: 3, estimateCU: 1.2 }, "needs-confirmation", ["over-budget", "batch-needs-yes"]],
    ["over budget and batch, --yes: still over-budget", { jobs: 3, estimateCU: 1.2, yes: true }, "needs-confirmation", ["over-budget"]],
    ["non-L4 without --yes/--rate", { gpu: "A100" }, "needs-confirmation", ["gpu-needs-rate"]],
    ["non-L4 with --yes but no explicit rate", { gpu: "A100", yes: true }, "needs-confirmation", ["gpu-needs-rate"]],
    ["non-L4 with explicit rate but no --yes", { gpu: "A100", rateExplicit: true }, "needs-confirmation", ["gpu-needs-rate"]],
    ["non-L4 with --yes and --rate", { gpu: "A100", yes: true, rateExplicit: true }, "proceed", []],
    ["L4 with an explicit rate needs nothing more", { rateExplicit: true }, "proceed", []],
    ["nothing to generate is always fine", { jobs: 0, estimateCU: 0, gpu: "A100" }, "proceed", []],
  ];
  for (const [name, over, decision, reasons] of rows) {
    test(name, () => {
      expect(decide({ ...base, ...over }).decision).toBe(decision);
      expect(codes(over)).toEqual(reasons);
    });
  }

  test("every needs-confirmation reason carries a hint; over-budget suggests a rounded-up budget", () => {
    const r = decide({ ...base, jobs: 3, estimateCU: 1.23, gpu: "A100" });
    expect(r.reasons.every((x) => x.hint.length > 0 && x.message.length > 0)).toBe(true);
    expect(r.reasons.find((x) => x.code === "over-budget")!.hint).toContain("--budget 1.3");
  });

  test("suggestedBudget rounds up to 0.1", () => {
    expect([suggestedBudget(0.77), suggestedBudget(1.0), suggestedBudget(1.01), suggestedBudget(0.1)]).toEqual([0.8, 1, 1.1, 0.1]);
  });
});
