import { redactSensitiveText } from "@autostack/contracts";

/**
 * The local-execution plan requires that "child logs are redacted and bounded". These are the
 * bounds: one line can never outgrow `maximumLineCharacters`, and one child can never write more
 * than `maximumTotalCharacters` in total, however chatty or hostile it becomes.
 */
export const CHILD_LOG_LIMITS = Object.freeze({
  maximumLineCharacters: 2_048,
  maximumTotalCharacters: 64_000
});

export interface ChildLogForwarderOptions {
  readonly service: string;
  readonly write: (line: string) => void;
}

export interface ChildLogForwarder {
  /** Accepts an arbitrary stream chunk; complete lines are emitted, a remainder is held. */
  push(chunk: string): void;
  /** Emits a held remainder, for a child that exits without a trailing newline. */
  flush(): void;
}

/**
 * Turns a utility child's raw stdio into bounded, redacted, structured records.
 *
 * Two reasons this exists rather than piping the stream onward. The child is the only thing that
 * knows why it failed -- the host daemon reports a startup failure as an exit code and nothing else
 * -- so its output has to reach the main process to be diagnosable in the shipped application, not
 * only under the e2e harness. And once the stream is piped, something must drain it: an undrained
 * pipe stalls a chatty child against a full buffer.
 */
export const createChildLogForwarder = ({
  service,
  write
}: ChildLogForwarderOptions): ChildLogForwarder => {
  let buffered = "";
  let written = 0;
  let stopped = false;

  const emit = (raw: string): void => {
    if (stopped) return;
    const bounded = raw.slice(0, CHILD_LOG_LIMITS.maximumLineCharacters);
    const record = JSON.stringify({
      level: "error",
      event: "utility_child_log",
      service,
      line: redactSensitiveText(bounded)
    });
    if (written + record.length > CHILD_LOG_LIMITS.maximumTotalCharacters) {
      stopped = true;
      write(
        JSON.stringify({ level: "error", event: "utility_child_log_truncated", service })
      );
      return;
    }
    written += record.length;
    write(record);
  };

  return {
    push(chunk: string): void {
      if (stopped) return;
      buffered += chunk;
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const line = buffered.slice(0, newline).replace(/\r$/u, "");
        buffered = buffered.slice(newline + 1);
        if (line.length > 0) emit(line);
        if (stopped) {
          buffered = "";
          return;
        }
        newline = buffered.indexOf("\n");
      }
      // A child that never writes a newline must not grow this buffer without bound.
      while (buffered.length >= CHILD_LOG_LIMITS.maximumLineCharacters) {
        emit(buffered.slice(0, CHILD_LOG_LIMITS.maximumLineCharacters));
        buffered = buffered.slice(CHILD_LOG_LIMITS.maximumLineCharacters);
        if (stopped) {
          buffered = "";
          return;
        }
      }
    },
    flush(): void {
      const remainder = buffered;
      buffered = "";
      if (remainder.length > 0) emit(remainder);
    }
  };
};
