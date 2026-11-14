import type { Charge, PolicyDecision } from "@tab/shared";

export type SlipMode = "item" | "manual";

export type SlipPhase =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "live"; charge: Charge }
  | {
      kind: "error";
      code: string;
      message: string;
      httpStatus: number;
      decision: PolicyDecision | null;
    };

export type SlipOrder = {
  merchantName: string;
  title: string;
  unit: string | null;
  amount: string | null;
  asset: string | null;
  description: string;
};

export type Attempt = {
  token: string;
  merchantId: string;
  amount: string;
  description: string;
  idempotencyKey: string;
  skuId: string | null;
  signature: string;
};

export type ManualFields = {
  merchantId: string;
  amount: string;
  description: string;
};
