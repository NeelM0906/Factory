import { describe, expect, it } from "vitest";

import { EventSequencer } from "../src/event-sequencer.js";

describe("EventSequencer", () => {
  it("allocates positive, strictly increasing sequence numbers", () => {
    const seq = new EventSequencer();
    const a = seq.next();
    const b = seq.next();
    const c = seq.next();

    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it("starts at 1", () => {
    const seq = new EventSequencer();
    expect(seq.next()).toBe(1);
  });

  it("survives the stream ending — resume continues above the last allocated number", () => {
    const seq = new EventSequencer();

    // Simulate a start() stream: allocate a few numbers
    seq.next(); // 1
    seq.next(); // 2

    // Simulate the stream ending (e.g., the adapter calls endStream)
    seq.endStream();

    // Simulate resume() — should continue from where we left off
    const resumed = seq.next();
    expect(resumed).toBe(3);
    expect(resumed).toBeGreaterThan(2);
  });

  it("tracks the last allocated number", () => {
    const seq = new EventSequencer();
    seq.next();
    seq.next();
    expect(seq.lastAllocated).toBe(2);
  });

  describe("lifecycle terminal guard", () => {
    it("prevents allocation after a lifecycle terminal event", () => {
      const seq = new EventSequencer();
      seq.next();
      seq.markTerminal();

      expect(() => seq.next()).toThrow();
    });

    it("interrupted is not a terminal — it ends the stream but allows resume", () => {
      const seq = new EventSequencer();
      seq.next();
      seq.markInterrupted();

      // After interrupted, the stream ends but the sequencer survives for resume
      seq.endStream();
      const next = seq.next();
      expect(next).toBe(2);
    });
  });

  describe("reset for new session", () => {
    it("reset clears the terminal flag and starts from 1", () => {
      const seq = new EventSequencer();
      seq.next();
      seq.next();
      seq.reset();

      expect(seq.next()).toBe(1);
    });
  });
});
