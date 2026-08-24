import { DesktopApiOperationMapSchema } from "@autostack/contracts";

import {
  createDesktopControlPlaneTransport,
  type DesktopLocalOperationDispatcher
} from "./control-plane-transport.js";

export interface DesktopRequestHandlerOptions<Event> {
  readonly authorize: (event: Event) => void;
  readonly getOrigin: () => string | undefined;
  readonly getToken: () => string | undefined;
  readonly fetch?: typeof globalThis.fetch;
  readonly localDispatcher?: DesktopLocalOperationDispatcher;
}

export const createDesktopRequestHandler =
  <Event>(options: DesktopRequestHandlerOptions<Event>) =>
  async (event: Event, candidate: unknown): Promise<unknown> => {
    options.authorize(event);
    const request = DesktopApiOperationMapSchema.parse(candidate);
    const origin = options.getOrigin();
    if (origin === undefined) throw new Error("Desktop runtime unavailable.");
    return await createDesktopControlPlaneTransport({
      origin,
      getToken: options.getToken,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.localDispatcher === undefined ? {} : { localDispatcher: options.localDispatcher })
    }).request(request as never);
  };
