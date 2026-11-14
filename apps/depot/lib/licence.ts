/**
 * The depot's own fulfilment key. This is not part of the TAB receipt: it is
 * the merchant's fulfilment artifact, issued when a charge settles. It is
 * deterministic for (charge, item), so re-rendering the slip shows the same
 * key and the key can be re-derived from the charge id.
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function fnv1a(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function fulfilmentKey(prefix: string, chargeId: string, skuId?: string): string {
  const cleanPrefix =
    prefix
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 8) || "DEPOT";

  let state = fnv1a(`${chargeId}:${skuId ?? "manual"}`);
  let body = "";
  for (let i = 0; i < 12; i++) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    body += ALPHABET[state % 32];
  }

  return `${cleanPrefix}-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
}
