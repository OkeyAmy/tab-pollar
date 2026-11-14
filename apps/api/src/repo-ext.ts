/**
 * Local extensions over the frozen `Repo` surface. Platform owns `packages/db`;
 * these helpers fill the small gaps the API needs without changing its names.
 *
 * As platform adds methods (committedSince, listChargesForAgent,
 * getChargesAwaitingSigner, validateLimits), the API uses those directly.
 */
import type { Repo } from "@tab/db";
import type { Charge, TxReceipt } from "@tab/shared";

type IdRow = { id: string };

export function updateAgentProfile(
  repo: Repo,
  id: string,
  patch: { name?: string; description?: string | null },
): void {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  if (patch.name !== undefined) {
    sets.push("name = @name");
    params.name = patch.name;
  }
  if (patch.description !== undefined) {
    sets.push("description = @description");
    params.description = patch.description;
  }
  if (sets.length === 0) return;
  repo.db.prepare(`UPDATE agents SET ${sets.join(", ")} WHERE id = @id`).run(params);
}

/** Persist a submitted-but-unconfirmed hash without changing charge status. */
export function setChargePartialReceipt(repo: Repo, id: string, receipt: TxReceipt): void {
  repo.db
    .prepare(`UPDATE charges SET receipt_json = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(receipt), new Date().toISOString(), id);
}

export interface PurchaseRow {
  id: string;
  licenseKey: string;
  skuId: string;
}

export function getPurchaseByChargeId(repo: Repo, chargeId: string): PurchaseRow | null {
  const row = repo.db
    .prepare(`SELECT id, license_key, sku_id FROM purchases WHERE charge_id = ? LIMIT 1`)
    .get(chargeId) as { id: string; license_key: string; sku_id: string } | undefined;
  return row
    ? { id: row.id, licenseKey: row.license_key, skuId: row.sku_id }
    : null;
}

export function listStaleChargeIds(
  repo: Repo,
  statuses: string[],
  beforeIso: string,
  column: "created_at" | "updated_at" = "created_at",
): string[] {
  const placeholders = statuses.map(() => "?").join(", ");
  const tsColumn = column === "updated_at" ? "updated_at" : "created_at";
  const rows = repo.db
    .prepare(
      `SELECT id FROM charges WHERE status IN (${placeholders}) AND ${tsColumn} <= ?`,
    )
    .all(...statuses, beforeIso) as IdRow[];
  return rows.map((row) => row.id);
}

export function chargesForIds(repo: Repo, ids: string[]): Charge[] {
  return ids
    .map((id) => repo.getCharge(id))
    .filter((charge): charge is Charge => charge !== null);
}
