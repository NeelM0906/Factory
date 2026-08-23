export const DARWIN_TERMINATING_SIGNALS = Object.freeze([
  "SIGABRT",
  "SIGALRM",
  "SIGBUS",
  "SIGEMT",
  "SIGFPE",
  "SIGHUP",
  "SIGILL",
  "SIGINT",
  "SIGKILL",
  "SIGPIPE",
  "SIGPROF",
  "SIGQUIT",
  "SIGSEGV",
  "SIGSYS",
  "SIGTERM",
  "SIGTRAP",
  "SIGUSR1",
  "SIGUSR2",
  "SIGVTALRM",
  "SIGXCPU",
  "SIGXFSZ"
] as const);

const SIGNALS: ReadonlySet<string> = new Set(DARWIN_TERMINATING_SIGNALS);

export type DarwinTerminatingSignal = (typeof DARWIN_TERMINATING_SIGNALS)[number];

export const isDarwinTerminatingSignal = (input: unknown): input is DarwinTerminatingSignal =>
  typeof input === "string" && SIGNALS.has(input);
