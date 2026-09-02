/**
 * Codex app-server JSON-RPC client.
 *
 * Drives the Codex app-server protocol over stdio. Outbound messages are
 * standard JSON-RPC 2.0 (with `jsonrpc: "2.0"`). Inbound messages from
 * Codex carry NO `jsonrpc` member:
 * - Responses: `{id, result}` or `{id, error}`
 * - Notifications: `{method, params, emittedAtMs}`
 *
 * Request/response correlation by id. Concurrent in-flight requests
 * resolved to the right callers. Notifications routed without a response.
 * A response to an unknown id is silently ignored. `close()` rejects every
 * in-flight request.
 */

export interface CodexNotification {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly emittedAtMs?: number;
}

type WriteFn = (data: string) => Promise<void>;
type NotificationHandler = (notification: CodexNotification) => void;

interface PendingRequest {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
}

export class CodexJsonRpcClient {
  readonly #write: WriteFn;
  readonly #onNotification: NotificationHandler | undefined;
  readonly #pending = new Map<number, PendingRequest>();
  #nextId = 0;
  #closed = false;

  constructor(write: WriteFn, onNotification?: NotificationHandler) {
    this.#write = write;
    this.#onNotification = onNotification;
  }

  /**
   * Send a JSON-RPC 2.0 request and return a promise that resolves with the result.
   */
  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(new Error("JSON-RPC client is closed."));
    }

    const id = this.#nextId;
    this.#nextId += 1;

    // Register before writing so handleFrame can resolve the promise even
    // if called synchronously after the write completes.
    const promise = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });

    const message = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params
    });

    await this.#write(message);

    return promise;
  }

  /**
   * Handle an inbound frame from the Codex app-server.
   * Dispatches to the appropriate handler based on the frame shape.
   */
  handleFrame(frame: Record<string, unknown>): void {
    // Response: has `id` (but no `method`)
    if ("id" in frame && typeof frame.id === "number") {
      const pending = this.#pending.get(frame.id);
      if (pending == null) return; // Unknown id — silently ignore

      this.#pending.delete(frame.id);

      if ("error" in frame && frame.error != null) {
        const error = frame.error as { code: number; message: string };
        pending.reject(new Error(`JSON-RPC error ${error.code}: ${error.message}`));
      } else {
        pending.resolve(frame.result);
      }
      return;
    }

    // Notification: has `method` (but no `id`)
    if ("method" in frame && typeof frame.method === "string") {
      const notification: CodexNotification = {
        method: frame.method,
        params: (frame.params ?? {}) as Record<string, unknown>,
        ...(typeof frame.emittedAtMs === "number"
          ? { emittedAtMs: frame.emittedAtMs }
          : {})
      };
      this.#onNotification?.(notification);
    }
  }

  /**
   * Close the client, rejecting every in-flight request.
   */
  close(): void {
    this.#closed = true;
    for (const [id, pending] of this.#pending) {
      pending.reject(new Error("JSON-RPC client is closed."));
      this.#pending.delete(id);
    }
  }
}
