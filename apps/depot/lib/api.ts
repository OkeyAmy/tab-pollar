import type { Charge, PolicyDecision } from "@tab/shared";
import { parseCatalogue, type Catalogue } from "@/lib/catalogue";

export class ApiFailure extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly decision: PolicyDecision | null;

  constructor(code: string, message: string, httpStatus = 0, decision: PolicyDecision | null = null) {
    super(message);
    this.name = "ApiFailure";
    this.code = code;
    this.httpStatus = httpStatus;
    this.decision = decision;
  }
}

type JsonResponse = { status: number; ok: boolean; json: unknown };

const REQUEST_TIMEOUT_MS = 12_000;

async function request(path: string, init?: RequestInit): Promise<JsonResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    if (name === "AbortError") {
      throw new ApiFailure("TIMEOUT", "TAB did not answer in time.", 0, null);
    }
    throw new ApiFailure(
      "NETWORK",
      "The till cannot reach TAB. Check that the API is running on port 4000.",
      0,
      null,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text().catch(() => "");
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  return { status: response.status, ok: response.ok, json };
}

function asCharge(value: unknown): Charge | null {
  if (!value || typeof value !== "object") return null;
  const charge = value as Record<string, unknown>;
  if (typeof charge.id !== "string" || typeof charge.status !== "string") return null;
  return value as Charge;
}

function extractDecision(details: unknown): PolicyDecision | null {
  if (!details || typeof details !== "object") return null;
  const outer = details as Record<string, unknown>;
  const candidate =
    outer.decision && typeof outer.decision === "object"
      ? (outer.decision as Record<string, unknown>)
      : outer;
  if (typeof candidate.code !== "string" || typeof candidate.message !== "string") return null;
  return {
    allowed: candidate.allowed === true,
    requiresApproval: candidate.requiresApproval === true,
    code: candidate.code as PolicyDecision["code"],
    message: candidate.message,
    checks: Array.isArray(candidate.checks) ? (candidate.checks as PolicyDecision["checks"]) : [],
  };
}

function errorFrom(status: number, json: unknown): ApiFailure {
  const root = json && typeof json === "object" ? (json as Record<string, unknown>) : null;
  const envelope =
    root && root.error && typeof root.error === "object"
      ? (root.error as Record<string, unknown>)
      : null;

  const code = typeof envelope?.code === "string" ? envelope.code : `HTTP_${status}`;
  const message =
    typeof envelope?.message === "string" && envelope.message.length > 0
      ? envelope.message
      : "The till could not complete the charge.";
  return new ApiFailure(code, message, status, extractDecision(envelope?.details));
}

export type ChargeInput = {
  token: string;
  merchantId: string;
  amount: string;
  description: string;
  idempotencyKey: string;
};

export async function postCharge(input: ChargeInput): Promise<Charge> {
  const response = await request("/api/v1/charges", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });

  const root = response.json && typeof response.json === "object" ? (response.json as Record<string, unknown>) : null;

  // A repeated idempotency key replays the original charge instead of creating one.
  if (response.status === 409) {
    const replay = asCharge(root?.charge ?? root);
    if (replay) return replay;
  }

  if (!response.ok) {
    throw errorFrom(response.status, response.json);
  }

  const charge = asCharge(root?.charge ?? root);
  if (!charge) {
    throw new ApiFailure(
      "BAD_RESPONSE",
      "TAB accepted the request but returned no charge record.",
      response.status,
      null,
    );
  }
  return charge;
}

export async function getCharge(id: string, token: string): Promise<Charge> {
  const path = `/api/v1/charges/${encodeURIComponent(id)}`;

  // Preferred: a header, so the token never lands in access logs or history.
  let response = await request(path, { headers: { "x-tab-token": token } });

  // Older API builds only read ?token=. Fall back once on 401, never send both.
  if (response.status === 401) {
    const query = new URLSearchParams({ token });
    response = await request(`${path}?${query.toString()}`);
  }

  if (!response.ok) {
    throw errorFrom(response.status, response.json);
  }

  const root = response.json && typeof response.json === "object" ? (response.json as Record<string, unknown>) : null;
  const charge = asCharge(root?.charge ?? root);
  if (!charge) {
    throw new ApiFailure("BAD_RESPONSE", "TAB returned a charge the till cannot read.", response.status, null);
  }
  return charge;
}

export async function fetchCatalogue(): Promise<Catalogue> {
  const response = await request("/api/v1/merchants");
  if (!response.ok) {
    throw errorFrom(response.status, response.json);
  }
  const catalogue = parseCatalogue(response.json);
  if (!catalogue) {
    throw new ApiFailure(
      "CATALOGUE_INVALID",
      "The price list came back in a shape the till does not know.",
      response.status,
      null,
    );
  }
  return catalogue;
}
