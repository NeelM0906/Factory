import { useCallback, useRef, useState } from "react";

import type {
  AnswerClarificationResponse,
  CancelRunResponse,
  SteerRunResponse
} from "@autostack/contracts";

import type { AutoStackApiClient } from "./api-client.js";
import { ApiRequestValidationError } from "./api-errors.js";

/** A validation or request failure surfaced on {@link FactoryActionState}, naming the offending field. */
export interface FactoryActionError {
  readonly field: string;
  readonly message: string;
}

export interface FactoryActionState {
  readonly steering: boolean;
  readonly cancelling: boolean;
  readonly answering: boolean;
  readonly steerError?: FactoryActionError;
  readonly cancelError?: FactoryActionError;
  readonly answerError?: FactoryActionError;
}

const idleActionState: FactoryActionState = {
  steering: false,
  cancelling: false,
  answering: false
};

const GENERIC_STEER_FAILURE = "The instruction could not be sent. Try again.";
const GENERIC_CANCEL_FAILURE = "The run could not be cancelled. Try again.";
const GENERIC_ANSWER_FAILURE = "The answer could not be sent. Try again.";

/**
 * Steer, cancel, and answer, composed into {@link FactoryController} by `use-factory.ts`'s single
 * composition line.
 *
 * `answerClarification` sends `{ answer, origin }` only — E1 (the Task 7 report escalation) is
 * resolved: `AnswerClarificationRequestSchema`/`AnswerClarificationResponseSchema`
 * (`@autostack/contracts` `api.ts`) landed with idempotency server-derived from the clarification
 * ref and answer content, and `actorId` from authenticated context, mirroring D2's
 * approval-decision pattern. `origin` is fixed to `"web"` here: this action has no signal for which
 * shell hosts it, and the desktop transport can't reach this route yet anyway (no
 * `factory.runs.answer` member in `DesktopApiOperationMap` — same D1 shape as the other four
 * operations). Revisit if/when desktop wiring for this route lands.
 */
export interface FactoryActionsController {
  readonly actionState: FactoryActionState;
  steer(runId: string, instruction: string): Promise<SteerRunResponse>;
  cancel(runId: string, reason: string): Promise<CancelRunResponse>;
  answerClarification(
    runId: string,
    clarificationRef: string,
    answer: string
  ): Promise<AnswerClarificationResponse>;
}

/**
 * Translates a thrown failure into a {@link FactoryActionError}. An `ApiRequestValidationError`
 * already names the offending field and never carries the offending value (it may be the
 * credential material the contract schema rejected); anything else collapses to a generic,
 * non-specific message under the `"request"` field.
 */
const toActionError = (error: unknown, fallbackMessage: string): FactoryActionError =>
  error instanceof ApiRequestValidationError
    ? { field: error.field, message: error.message }
    : { field: "request", message: fallbackMessage };

/**
 * The steer and cancel factory actions. Each follows `useFactory`'s `createRun` shape: abort the
 * in-flight controller for that action, set a busy flag, act, refresh on success, and translate
 * failure into a message on `actionState` rather than an unhandled rejection (the returned promise
 * still rejects, exactly as `createRun` does, so a caller that awaits it observes the failure too).
 */
export function useFactoryActions(
  client: AutoStackApiClient | null,
  refresh: () => Promise<void>
): FactoryActionsController {
  const [actionState, setActionState] = useState<FactoryActionState>(idleActionState);
  const steerRequest = useRef<AbortController | null>(null);
  const cancelRequest = useRef<AbortController | null>(null);
  const answerRequest = useRef<AbortController | null>(null);

  const steer = useCallback(
    async (runId: string, instruction: string): Promise<SteerRunResponse> => {
      if (client === null) throw new TypeError("The factory is disconnected.");
      steerRequest.current?.abort();
      const controller = new AbortController();
      steerRequest.current = controller;
      setActionState((current) => ({ ...current, steering: true }));
      try {
        const response = await client.steerRun(runId, { instruction }, controller.signal);
        if (!controller.signal.aborted) {
          await refresh();
          setActionState((current) => {
            const { steerError: ignoredSteerError, ...withoutSteerError } = current;
            void ignoredSteerError;
            return { ...withoutSteerError, steering: false };
          });
        }
        return response;
      } catch (error) {
        if (!controller.signal.aborted) {
          setActionState((current) => ({
            ...current,
            steering: false,
            steerError: toActionError(error, GENERIC_STEER_FAILURE)
          }));
        }
        throw error;
      } finally {
        if (steerRequest.current === controller) steerRequest.current = null;
      }
    },
    [client, refresh]
  );

  const cancel = useCallback(
    async (runId: string, reason: string): Promise<CancelRunResponse> => {
      if (client === null) throw new TypeError("The factory is disconnected.");
      cancelRequest.current?.abort();
      const controller = new AbortController();
      cancelRequest.current = controller;
      setActionState((current) => ({ ...current, cancelling: true }));
      try {
        const response = await client.cancelRun(runId, { reason }, controller.signal);
        if (!controller.signal.aborted) {
          await refresh();
          setActionState((current) => {
            const { cancelError: ignoredCancelError, ...withoutCancelError } = current;
            void ignoredCancelError;
            return { ...withoutCancelError, cancelling: false };
          });
        }
        return response;
      } catch (error) {
        if (!controller.signal.aborted) {
          setActionState((current) => ({
            ...current,
            cancelling: false,
            cancelError: toActionError(error, GENERIC_CANCEL_FAILURE)
          }));
        }
        throw error;
      } finally {
        if (cancelRequest.current === controller) cancelRequest.current = null;
      }
    },
    [client, refresh]
  );

  const answerClarification = useCallback(
    async (
      runId: string,
      clarificationRef: string,
      answer: string
    ): Promise<AnswerClarificationResponse> => {
      if (client === null) throw new TypeError("The factory is disconnected.");
      answerRequest.current?.abort();
      const controller = new AbortController();
      answerRequest.current = controller;
      setActionState((current) => ({ ...current, answering: true }));
      try {
        const response = await client.answerClarification(
          runId,
          clarificationRef,
          { answer, origin: "web" },
          controller.signal
        );
        if (!controller.signal.aborted) {
          await refresh();
          setActionState((current) => {
            const { answerError: ignoredAnswerError, ...withoutAnswerError } = current;
            void ignoredAnswerError;
            return { ...withoutAnswerError, answering: false };
          });
        }
        return response;
      } catch (error) {
        if (!controller.signal.aborted) {
          setActionState((current) => ({
            ...current,
            answering: false,
            answerError: toActionError(error, GENERIC_ANSWER_FAILURE)
          }));
        }
        throw error;
      } finally {
        if (answerRequest.current === controller) answerRequest.current = null;
      }
    },
    [client, refresh]
  );

  return { actionState, steer, cancel, answerClarification };
}
