/**
 * The browser signer bus. One in-process set of SSE streams; the API pushes
 * payment intents to whichever tabs are online for that owner.
 *
 * The API never signs: it only describes a payment and waits for the browser
 * to report the transaction hash back.
 */
import { newId } from "@tab/shared";

const ENCODER = new TextEncoder();
const HEARTBEAT_MS = 15_000;

export interface SignerClient {
  id: string;
  ownerId: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
}

export interface SignerBus {
  readonly size: number;
  add(client: SignerClient): void;
  remove(client: SignerClient): void;
  broadcast(ownerId: string, event: string, data: unknown): void;
}

export function createSignerBus(): SignerBus {
  const clients = new Set<SignerClient>();
  return {
    get size() {
      return clients.size;
    },
    add(client) {
      clients.add(client);
    },
    remove(client) {
      clients.delete(client);
    },
    broadcast(ownerId, event, data) {
      const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const client of clients) {
        if (client.ownerId !== ownerId) continue;
        try {
          client.controller.enqueue(ENCODER.encode(frame));
        } catch {
          clients.delete(client);
        }
      }
    },
  };
}

export interface SseConnection {
  stream: ReadableStream<Uint8Array>;
  close: () => void;
}

/**
 * Build an SSE response body that is registered with the bus. `hello` is sent
 * immediately, then a comment heartbeat every 15 s. `close()` is idempotent.
 */
export function sseConnection(bus: SignerBus, ownerId: string): SseConnection {
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let client: SignerClient | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    if (client) bus.remove(client);
    try {
      controllerRef?.close();
    } catch {
      // Already closed by the runtime.
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      client = { id: newId("session"), ownerId, controller };
      bus.add(client);
      controller.enqueue(
        ENCODER.encode(
          `event: hello\ndata: ${JSON.stringify({ type: "hello", signerId: client.id })}\n\n`,
        ),
      );
      heartbeat = setInterval(() => {
        if (closed || !controllerRef) return;
        try {
          controllerRef.enqueue(ENCODER.encode(": ping\n\n"));
        } catch {
          close();
        }
      }, HEARTBEAT_MS);
    },
    cancel() {
      close();
    },
  });

  return { stream, close };
}
