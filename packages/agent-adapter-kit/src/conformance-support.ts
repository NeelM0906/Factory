/**
 * Conformance test scaffold shared by all three adapter packages.
 *
 * Exports the macrotask-deferring fixture wrapper (so a quiesce calibrated to a fixed
 * number of turns cannot pass) and the in-memory evidence sink.
 */

export { InMemoryEvidenceSink } from "./evidence-sink.js";
export { EventSequencer } from "./event-sequencer.js";
