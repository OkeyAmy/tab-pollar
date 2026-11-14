/**
 * Reservation hygiene. Two clocks:
 *  - signer jobs older than 2 minutes (browser rail only) expire;
 *  - AWAITING_APPROVAL older than 10 minutes expires and releases its budget,
 *    so a forgotten approval cannot lock a card forever.
 */
import type { Repo } from "@tab/db";
import { newId } from "@tab/shared";
import type { ApiConfig } from "./env.js";
import type { SignerBus } from "./signer-bus.js";
import { chargesForIds, listStaleChargeIds } from "./repo-ext.js";
import type { X402Store } from "./x402.js";

export interface ExpiryDeps {
  repo: Repo;
  bus: SignerBus;
  x402: X402Store;
  config: ApiConfig;
}

function expire(args: {
  repo: Repo;
  x402: X402Store;
  chargeId: string;
  reason: string;
  summary: string;
}): boolean {
  const charge = args.repo.getCharge(args.chargeId);
  if (!charge) return false;
  if (
    charge.status !== "QUEUED" &&
    charge.status !== "SIGNING" &&
    charge.status !== "AWAITING_APPROVAL"
  ) {
    return false;
  }

  args.repo.db.transaction(() => {
    args.repo.releaseBudget(charge.cardId, charge.amount);
    args.repo.setChargeStatus(charge.id, "EXPIRED", { error: args.reason });
    args.repo.cancelSignerJob(charge.id);
    args.x402.setStatus(charge.id, "EXPIRED");
    args.repo.appendEvent({
      id: newId("event"),
      ownerId: charge.ownerId,
      cardId: charge.cardId,
      chargeId: charge.id,
      type: "CHARGE_FAILED",
      actor: "system:expiry",
      summary: args.summary,
      data: { reason: args.reason, amount: charge.amount },
      createdAt: new Date().toISOString(),
    });
  })();

  return true;
}

export function expireStaleCharges(
  deps: ExpiryDeps,
  now = new Date(),
): number {
  const { repo, bus, x402, config } = deps;
  let count = 0;

  if (config.signerMode === "browser") {
    const signerCutoff = new Date(
      now.getTime() - config.signerExpiryMs,
    ).toISOString();
    // A charge approved after waiting must get its full signing window: use
    // `updated_at` (set on approval/claim), not the original `created_at`.
    const signerCharges = chargesForIds(
      repo,
      listStaleChargeIds(repo, ["QUEUED", "SIGNING"], signerCutoff, "updated_at"),
    );
    for (const charge of signerCharges) {
      if (
        expire({
          repo,
          x402,
          chargeId: charge.id,
          reason: "SIGNER_TIMEOUT",
          summary: "Signer did not settle this charge in time",
        })
      ) {
        count += 1;
        bus.broadcast(charge.ownerId, "payment.cancelled", {
          type: "payment.cancelled",
          chargeId: charge.id,
        });
      }
    }
  }

  const approvalCutoff = new Date(
    now.getTime() - config.approvalTtlMs,
  ).toISOString();
  const approvalCharges = chargesForIds(
    repo,
    listStaleChargeIds(repo, ["AWAITING_APPROVAL"], approvalCutoff),
  );
  for (const charge of approvalCharges) {
    if (
      expire({
        repo,
        x402,
        chargeId: charge.id,
        reason: "APPROVAL_EXPIRED",
        summary: "Approval expired; reservation released",
      })
    ) {
      count += 1;
    }
  }

  return count;
}

export function startExpiryLoop(
  deps: ExpiryDeps,
  intervalMs = 30_000,
): () => void {
  const timer = setInterval(() => {
    try {
      expireStaleCharges(deps);
    } catch (err) {
      console.error(
        "[tab/api] expiry loop:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
