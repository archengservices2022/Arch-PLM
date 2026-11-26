import { LifecycleState } from "../generated/prisma/enums.ts";

// ============================================================
// Arch PLM - "Start here" steps on the dashboard (UI help only).
//
// Pure logic: which of the four first steps are already done, judged only
// from counts the dashboard has already loaded. It grants nothing and checks
// nothing - every action is still decided on the server as before.
// ============================================================

export type GettingStartedStep = {
  key: "item" | "cad" | "review" | "approve";
  title: string;
  hint: string;
  /** In-page anchor of the section where the step is done. */
  href: string;
  done: boolean;
};

export type GettingStartedInput = {
  itemCount: number;
  cadDocumentCount: number;
  lifecycleCounts: Record<LifecycleState, number>;
};

export function gettingStartedSteps(input: GettingStartedInput): GettingStartedStep[] {
  const c = input.lifecycleCounts;
  const approvedOrLater = c.APPROVED + c.RELEASED + c.SUPERSEDED;
  const submittedOrLater = c.IN_REVIEW + approvedOrLater;
  return [
    {
      key: "item",
      title: "Create an item",
      hint: "In “Create item”: item number, description, type and the first Rev (for example A) and a short revision note, then click Add item.",
      href: "#create-item",
      done: input.itemCount > 0,
    },
    {
      key: "cad",
      title: "Attach its CAD file",
      hint: "In “CAD documents”, choose the revision and the .ipt / .iam / .idw file, then Attach.",
      href: "#cad-documents",
      done: input.cadDocumentCount > 0,
    },
    {
      key: "review",
      title: "Send it for review",
      hint: "In “Engineering revisions”, choose Move to → In Review on the revision and click Update.",
      href: "#revisions",
      done: submittedOrLater > 0,
    },
    {
      key: "approve",
      title: "Approve and release",
      hint: "Another person with the Approver or Admin role does this - never the person who created or submitted the revision. An Admin can add that person under Users.",
      href: "#revisions",
      done: approvedOrLater > 0,
    },
  ];
}

export function allStepsDone(steps: GettingStartedStep[]): boolean {
  return steps.every((step) => step.done);
}
