export {
  SlackRequestError,
  classifySlackFailure,
  type SlackFailureClassification,
  type SlackFailureClassificationInput,
  type SlackFailureCode,
  type SlackRequestErrorOptions
} from "./errors.js";
export { verifySlackSignature, type VerifySlackSignatureInput } from "./http/signature.js";
export {
  SlackUnsupportedEventError,
  buildSlackDeliveryDeduplicationKey,
  parseSlackEventDelivery,
  parseSlackUrlVerificationChallenge,
  type ParseSlackEventDeliveryInput,
  type ParseSlackUrlVerificationChallengeInput,
  type SlackUnsupportedEventReason
} from "./ingress/event-delivery.js";
export {
  parseSlackApprovalAction,
  parseSlackMessageAction,
  type ParseSlackApprovalActionInput,
  type ParseSlackMessageActionInput,
  type SlackApprovalActionBinding
} from "./ingress/interactivity.js";
export {
  createMemoryIngressQueue,
  type CreateMemoryIngressQueueOptions,
  type IngressQueue,
  type QueuedEnvelope
} from "./socket-mode/queue.js";
export {
  createGlobalWebSocketFactory,
  type SocketLike,
  type WebSocketConstructorLike,
  type WebSocketFactory
} from "./socket-mode/transport.js";
export {
  createSocketModeClient,
  type SocketModeClient,
  type SocketModeDependencies
} from "./socket-mode/client.js";
export { assertPostable, type SlackMessageComposition } from "./message/postable.js";
export { composeSlackMessage, type SlackMessageEnvelope } from "./message/compose.js";
export {
  buildApprovalPromptBlocks,
  composeApprovalPrompt,
  type ComposeApprovalPromptInput,
  type SlackActionsBlock,
  type SlackBlock,
  type SlackBlockText,
  type SlackButtonElement,
  type SlackSectionBlock
} from "./message/approval-prompt.js";
export {
  createSlackChatClient,
  type SlackChatClient,
  type SlackChatDependencies,
  type SlackPostMessageRequest,
  type SlackPostMessageResult
} from "./client/chat.js";
export {
  createMemoryIdempotencyRecordStore,
  createSlackIntegration,
  type IdempotencyRecordStore,
  type SlackChannelBinding,
  type SlackIntegration,
  type SlackIntegrationDependencies
} from "./integration.js";
