/**
 * Small HTTP helpers: the frozen error envelope, JSON body reading and zod
 * validation. Keeping these in one place means every route fails the same way.
 */
import type { Context } from "hono";
import type { z } from "zod";

export type ErrorStatus = 400 | 401 | 402 | 403 | 404 | 409 | 429 | 500;

export function fail(
  c: Context,
  status: ErrorStatus,
  code: string,
  message: string,
  details?: unknown,
): Response {
  return c.json(
    {
      error: {
        code,
        message,
        ...(details === undefined ? {} : { details }),
      },
    },
    status,
  );
}

export type ReadBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; response: Response };

export async function readJson(c: Context): Promise<ReadBodyResult> {
  try {
    return { ok: true, value: await c.req.json() };
  } catch {
    return {
      ok: false,
      response: fail(c, 400, "VALIDATION_ERROR", "Request body must be valid JSON."),
    };
  }
}

export type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; response: Response };

export function parseWith<T>(
  c: Context,
  schema: z.ZodType<T>,
  value: unknown,
): ParseResult<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      response: fail(c, 400, "VALIDATION_ERROR", "Request body is invalid.", {
        issues: parsed.error.issues,
      }),
    };
  }
  return { ok: true, data: parsed.data };
}
