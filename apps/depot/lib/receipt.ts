import type { Charge } from "@tab/shared";

/**
 * A receipt is only good when all of these hold:
 *  - the charge settled,
 *  - a receipt was actually returned,
 *  - the API did not mark it unverified on-chain,
 *  - it did not come from the demo/mock settlement rail.
 *
 * Anything else keeps the goods held and the PAID stamp off the slip.
 */
export function isVerifiedReceipt(charge: Charge): boolean {
  const receipt = charge.receipt;
  return (
    charge.status === "SETTLED" &&
    receipt != null &&
    receipt.onchainVerified !== false &&
    receipt.settlement !== "mock"
  );
}
