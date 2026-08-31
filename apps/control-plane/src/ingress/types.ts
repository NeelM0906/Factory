import type {
  IngressDelivery,
  IntegrationIngressPort,
  SlackApprovalAction
} from "@autostack/contracts";

/**
 * Dependency shapes for the control-plane webhook ingress routes (decision D8, Task 15).
 *
 * These routes deliberately import nothing from either provider's own adapter package:
 * `apps/control-plane/package.json` cannot gain a dependency on either one in this stream, so
 * every provider-specific behaviour (signature verification, payload parsing) arrives as an
 * injected function. The composition root wires the real adapter implementations at startup;
 * these route factories only orchestrate the injected functions in
 * the right order.
 */

export interface VerifySignatureInput {
  readonly rawBody: Uint8Array;
  readonly signatureHeader: string | null;
}

export interface ParseGitHubDeliveryInput {
  readonly eventHeader: string;
  readonly deliveryIdHeader: string;
  readonly payload: unknown;
  readonly receivedAt: string;
}

export interface GitHubIngressDependencies {
  readonly ingress: IntegrationIngressPort;
  /** Verifies `X-Hub-Signature-256` over the raw request bytes. Throws on any failure. */
  readonly verifySignature: (input: VerifySignatureInput) => void;
  /** Maps a webhook payload onto an `IngressDelivery`. Throws for unsupported/not-actionable events. */
  readonly parseDelivery: (input: ParseGitHubDeliveryInput) => IngressDelivery;
  /** Classifies whether an error thrown by `parseDelivery` means "ignore, don't fail". */
  readonly isUnsupportedEvent: (error: unknown) => boolean;
  readonly now: () => string;
  /** Closed ingress means `503`, never a swallowed `202` — see the route for the full rationale. */
  readonly isOpen: () => boolean;
  /** Default 1 MiB. */
  readonly maximumBodyBytes?: number;
  /** Default `/ingress/github` — outside the bearer-protected `/v1` surface (decision D8). */
  readonly basePath?: string;
}

export interface SlackVerifySignatureInput {
  readonly rawBody: Uint8Array;
  readonly signatureHeader: string | null;
  readonly timestampHeader: string | null;
}

export interface ParseSlackPayloadInput {
  readonly payload: unknown;
  readonly receivedAt: string;
}

/**
 * Records an approve/reject interaction. Mirrors `IntegrationIngressPort.accept` but for
 * `SlackApprovalAction`, which is a distinct shape from `IngressDelivery` (a button click, not a
 * webhook event) and so is not deduplicated through the same port.
 */
export interface SlackApprovalSink {
  record(action: SlackApprovalAction): Promise<{ readonly replayed: boolean }>;
}

export interface SlackIngressDependencies {
  readonly ingress: IntegrationIngressPort;
  readonly approvals: SlackApprovalSink;
  /** Verifies `X-Slack-Signature` over the raw request bytes and the request timestamp. */
  readonly verifySignature: (input: SlackVerifySignatureInput) => void;
  /** Maps an Events API `event_callback` envelope onto an `IngressDelivery`. */
  readonly parseEventDelivery: (input: ParseSlackPayloadInput) => IngressDelivery;
  /** Maps a `message_action` interactivity payload onto an `IngressDelivery`. */
  readonly parseMessageAction: (input: ParseSlackPayloadInput) => IngressDelivery;
  /** Maps a `block_actions` interactivity payload onto a `SlackApprovalAction`. */
  readonly parseApprovalAction: (input: ParseSlackPayloadInput) => SlackApprovalAction;
  /** Classifies whether an error thrown by a parse function means "ignore, don't fail". */
  readonly isUnsupportedEvent: (error: unknown) => boolean;
  readonly now: () => string;
  /** Closed ingress means `503`, never a swallowed `202` — see the routes for the full rationale. */
  readonly isOpen: () => boolean;
  /** Default 1 MiB. */
  readonly maximumBodyBytes?: number;
  /** Default `/ingress/slack/events` — outside the bearer-protected `/v1` surface (decision D8). */
  readonly eventsPath?: string;
  /** Default `/ingress/slack/interactivity` — outside the bearer-protected `/v1` surface. */
  readonly interactivityPath?: string;
}
