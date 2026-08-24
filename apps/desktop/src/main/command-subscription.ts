import {
  DesktopCommandStreamRequestSchema,
  RunnerSubscriptionItemSchema,
  type DesktopCommandStreamRequest,
  type RunnerSubscriptionItem
} from "@autostack/contracts";

export interface CommandSubscriptionOptions {
  readonly origin: string;
  readonly getToken: () => string | undefined;
  readonly request: DesktopCommandStreamRequest;
  readonly signal: AbortSignal;
  readonly emit: (item: RunnerSubscriptionItem) => void;
  readonly fetch?: typeof globalThis.fetch;
  readonly retryLimit?: number;
}

const MAXIMUM_LINE_BYTES = 1_048_576;

export const followDesktopCommand = async (options: CommandSubscriptionOptions): Promise<void> => {
  const request = DesktopCommandStreamRequestSchema.parse(options.request);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  let after = request.after;
  let attempts = 0;
  const retryLimit = options.retryLimit ?? 3;
  while (!options.signal.aborted) {
    const token = options.getToken();
    if (token === undefined) throw new Error("Desktop runtime unavailable.");
    const response = await fetchImplementation(
      `${options.origin}/v1/local/environments/${encodeURIComponent(request.environmentId)}/commands/${encodeURIComponent(request.commandId)}/events?after=${after}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: options.signal
      }
    );
    if (!response.ok || response.body === null) {
      throw new Error("Desktop command subscription unavailable.");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffered = "";
    let reconnect = false;
    while (!options.signal.aborted) {
      const chunk = await reader.read();
      buffered += decoder.decode(chunk.value, { stream: !chunk.done });
      if (Buffer.byteLength(buffered, "utf8") > MAXIMUM_LINE_BYTES) {
        await reader.cancel();
        throw new Error("Desktop command subscription frame is too large.");
      }
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line.length > 0) {
          const item = RunnerSubscriptionItemSchema.parse(JSON.parse(line));
          options.emit(item);
          if (item.type === "subscription.lagged") {
            after = item.resumeCursor;
            reconnect = true;
            await reader.cancel();
            break;
          }
          after = item.event.sequence;
          if (item.event.type === "command.completed" || item.event.type === "stream.error") {
            return;
          }
        }
        newline = buffered.indexOf("\n");
      }
      if (reconnect || chunk.done) break;
    }
    attempts += 1;
    if (attempts > retryLimit) {
      throw new Error("Desktop command subscription retry limit reached.");
    }
  }
};
