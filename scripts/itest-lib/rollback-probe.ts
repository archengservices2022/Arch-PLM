/**
 * Rollback-only probe for integration gates (B03, Codex NO-GO finding 2).
 *
 * Runs `operation` inside an interactive transaction that is ALWAYS rolled
 * back - whether the operation fails (the expected case for a prohibited
 * operation) or unexpectedly succeeds (e.g. a protection trigger is absent).
 * Nothing the operation does can be committed. The caller decides what an
 * unexpected success means (the B03 gate stops immediately).
 */
import type { PrismaClient } from "../../app/generated/prisma/client.ts";

class ProbeRollback extends Error {}

export type RollbackProbeResult =
  | { refused: true; message: string }
  | { refused: false };

export async function runRollbackOnlyProbe(
  prisma: PrismaClient,
  operation: (tx: PrismaClient) => Promise<unknown>,
): Promise<RollbackProbeResult> {
  let outcome: RollbackProbeResult | null = null;
  try {
    await prisma.$transaction(async (tx) => {
      try {
        await operation(tx as unknown as PrismaClient);
        outcome = { refused: false };
      } catch (error) {
        outcome = { refused: true, message: error instanceof Error ? error.message : String(error) };
      }
      // ALWAYS roll back.
      throw new ProbeRollback("rollback-only probe");
    });
  } catch (error) {
    if (!(error instanceof ProbeRollback) && outcome === null) {
      outcome = { refused: true, message: error instanceof Error ? error.message : String(error) };
    }
  }
  return outcome ?? { refused: true, message: "probe transaction did not run" };
}
