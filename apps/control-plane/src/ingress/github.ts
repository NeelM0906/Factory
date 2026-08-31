import type { Context, Hono } from "hono";

import type { GitHubIngressDependencies } from "./types.js";

const DEFAULT_BASE_PATH = "/ingress/github";
const DEFAULT_MAXIMUM_BODY_BYTES = 1024 * 1024;

type ErrorCode =
  "unauthorized" | "invalid_request" | "request_too_large" | "local_runner_unavailable";

class BodyTooLargeError extends Error {}

const errorResponse = (
  context: Context,
  status: 401 | 400 | 413 | 503,
  code: ErrorCode,
  message: string
): Response => context.json({ error: { code, message } }, status);

/**
 * Reads the request body once as raw bytes, enforcing `maximumBodyBytes` while streaming so an
 * oversized body is never buffered past the cap. The same bytes are later handed to the signature
 * verifier and to `JSON.parse` — never re-encoded in between, which is what makes signature
 * verification meaningful (GitHub signs the exact bytes it sent).
 */
async function readRawBody(request: Request, maximumBodyBytes: number): Promise<Uint8Array> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > maximumBodyBytes) {
    throw new BodyTooLargeError();
  }
  const reader = request.body?.getReader();
  if (reader === undefined) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > maximumBodyBytes) {
      await reader.cancel();
      throw new BodyTooLargeError();
    }
    chunks.push(chunk.value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/**
 * Registers `POST {basePath}` (default `/ingress/github`) on `app`. Mounting is the caller's
 * concern — this factory never touches `app.ts`, and it never mounts under `/v1/*`: webhooks
 * authenticate by provider signature over the raw body, never by the bearer token that guards the
 * versioned API surface (decision D8). Punching a bearer exemption into `/v1/*` for this route
 * would be a hole in that wall; a separate, signature-only surface has no wall to hole.
 */
export function registerGitHubIngress(app: Hono, deps: GitHubIngressDependencies): void {
  const path = deps.basePath ?? DEFAULT_BASE_PATH;
  const maximumBodyBytes = deps.maximumBodyBytes ?? DEFAULT_MAXIMUM_BODY_BYTES;

  app.post(path, async (context) => {
    let rawBody: Uint8Array;
    try {
      rawBody = await readRawBody(context.req.raw, maximumBodyBytes);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return errorResponse(context, 413, "request_too_large", "The request body is too large.");
      }
      throw error;
    }

    // Signature verification runs before the isOpen check below. If it ran after, a closed
    // ingress would answer an unsigned probe request with a distinguishable "closed" response
    // before ever checking whether the caller could prove it was GitHub — turning ingress-closed
    // into an unauthenticated oracle. Verifying first means a bad signature is always 401,
    // whether ingress is open or closed.
    try {
      deps.verifySignature({
        rawBody,
        signatureHeader: context.req.header("X-Hub-Signature-256") ?? null
      });
    } catch {
      return errorResponse(context, 401, "unauthorized", "The webhook signature is invalid.");
    }

    // Ingress closed means the local runner generation cannot accept work right now. This
    // deliberately answers 503, never a 202: GitHub redelivers on a non-2xx response, so a 503
    // here lets GitHub's own retry machinery recover the delivery once ingress reopens. Answering
    // 202 (or 200) and then dropping the delivery would hand back a success receipt for an event
    // we never actually accepted — a silently lost event with a passing status code. Do not "fix"
    // this into a 202; that is the wrong implementation this comment exists to rule out.
    if (!deps.isOpen()) {
      return errorResponse(
        context,
        503,
        "local_runner_unavailable",
        "Ingress is not currently accepting deliveries."
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(rawBody)) as unknown;
    } catch {
      return errorResponse(context, 400, "invalid_request", "The request body is invalid JSON.");
    }

    let delivery;
    try {
      delivery = deps.parseDelivery({
        eventHeader: context.req.header("X-GitHub-Event") ?? "",
        deliveryIdHeader: context.req.header("X-GitHub-Delivery") ?? "",
        payload,
        receivedAt: deps.now()
      });
    } catch (error) {
      if (deps.isUnsupportedEvent(error)) return context.json({ ignored: true }, 202);
      return errorResponse(context, 400, "invalid_request", "The webhook payload is invalid.");
    }

    let result: { readonly replayed: boolean };
    try {
      result = await deps.ingress.accept(delivery);
    } catch {
      return errorResponse(
        context,
        503,
        "local_runner_unavailable",
        "The delivery could not be accepted."
      );
    }

    if (result.replayed) return context.json({ replayed: true }, 200);
    return context.json({ accepted: true }, 202);
  });
}
