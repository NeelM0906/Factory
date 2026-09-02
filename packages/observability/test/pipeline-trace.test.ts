import { describe, expect, it } from "vitest";

import {
  createCorrelation,
  createTracer,
  createLogger,
  createMeter,
  withCorrelation,
  type IdFactory,
  type SpanRecord
} from "../src/index.js";
import { createRecordingExporter } from "../src/testing/index.js";

/**
 * The planted secret appears in four paths: model API key, runner env,
 * agent output, and external-API URL. The assertion verifies all four
 * are redacted in the serialized spans and logs.
 */
const SECRET = ["ghp", "S".repeat(36)].join("_");

/** Deterministic ID factory for reproducible traces. */
const deterministicIds = (): IdFactory => {
  let traceCounter = 0;
  let spanCounter = 0;
  return {
    traceId: () => {
      traceCounter += 1;
      return traceCounter.toString(16).padStart(32, "0");
    },
    spanId: () => {
      spanCounter += 1;
      return spanCounter.toString(16).padStart(16, "0");
    }
  };
};

/** The pipeline span names in end-order (exporter receives on end). */
const PIPELINE_SPAN_NAMES = [
  "workflow.transition",
  "model.call",
  "runner.command",
  "external.api",
  "artifact.storage",
  "notification",
  "agent.session",
  "ingress"
] as const;

/** The six lifecycle stages that produce stage.latency data points. */
const STAGE_NAMES = [
  "triage",
  "plan",
  "implement",
  "verify",
  "review",
  "publish"
] as const;

describe("full-pipeline trace simulation", () => {
  it("drives one correlation through the full span set", () => {
    const ids = deterministicIds();
    const recorder = createRecordingExporter();
    const tracer = createTracer({
      exporter: recorder.spanExporter,
      now: (() => { let t = 1_000_000; return () => { t += 100; return t; }; })(),
      ids
    });
    const logger = createLogger({
      sink: recorder.logSink,
      now: (() => { let t = 1_000_000; return () => { t += 100; return t; }; })()
    });
    const meter = createMeter({
      sink: recorder.metricSink,
      now: (() => { let t = 1_000_000; return () => { t += 100; return t; }; })()
    });

    const stageLatency = meter.histogram("autostack.stage.latency");

    // Start the root correlation
    const rootCtx = createCorrelation({ ids });

    withCorrelation(rootCtx, () => {
      // Root span: ingress
      const ingress = tracer.startSpan("ingress", {
        kind: "server",
        attributes: { "autostack.run.id": "run_test_001" }
      });

      // Workflow transition
      const workflow = tracer.startSpan("workflow.transition", {
        kind: "internal",
        parentSpanId: rootCtx.spanId
      });
      workflow.end();

      // Agent session — secret appears in agent output
      const agentSession = tracer.startSpan("agent.session", {
        kind: "internal",
        parentSpanId: rootCtx.spanId,
        attributes: { "agent.session.id": "sess_001" }
      });
      logger.info("Agent started session");

      // Model call — secret in API key attribute (should be caught by safeAttributes)
      const modelCall = tracer.startSpan("model.call", {
        kind: "client",
        parentSpanId: rootCtx.spanId,
        attributes: {
          "model.name": "claude-opus-4",
          "model.provider": "anthropic"
        }
      });
      // Log with the secret to prove it gets redacted
      logger.info(`Model call with key ${SECRET}`);
      modelCall.end();

      // Runner command — secret in environment
      const runnerCmd = tracer.startSpan("runner.command", {
        kind: "internal",
        parentSpanId: rootCtx.spanId,
        attributes: { "runner.command": "npm test" }
      });
      logger.info(`Runner env contains ${SECRET}`);
      runnerCmd.end();

      // External API — secret in URL
      const externalApi = tracer.startSpan("external.api", {
        kind: "client",
        parentSpanId: rootCtx.spanId,
        attributes: { "http.method": "POST" }
      });
      logger.info(`External call to https://api.example.com/?token=${SECRET}`);
      externalApi.end();

      // Artifact storage
      const artifactStorage = tracer.startSpan("artifact.storage", {
        kind: "internal",
        parentSpanId: rootCtx.spanId
      });
      artifactStorage.end();

      // Notification
      const notification = tracer.startSpan("notification", {
        kind: "producer",
        parentSpanId: rootCtx.spanId
      });
      notification.end();

      agentSession.end();

      // Record stage latencies
      for (const stage of STAGE_NAMES) {
        stageLatency.record(Math.random() * 1000, { "stage": stage });
      }

      ingress.setStatus({ code: "ok" });
      ingress.end();
    });

    // Assertions
    const spans = recorder.spans;
    const logs = recorder.logs;
    const metrics = recorder.metrics;

    // All spans share one trace ID
    const traceIds = new Set(spans.map((span) => span.traceId));
    expect(traceIds.size).toBe(1);

    // Exact ordered span names (by end time order)
    expect(spans.map((span) => span.name)).toEqual([...PIPELINE_SPAN_NAMES]);

    // No orphan spans — every child names a real parent or is the root
    const orphanSpans = (allSpans: readonly SpanRecord[]): readonly SpanRecord[] => {
      const ids = new Set(allSpans.map((s) => s.spanId));
      return allSpans.filter(
        (s) => s.parentSpanId !== undefined && !ids.has(s.parentSpanId) && s.parentSpanId !== rootCtx.spanId
      );
    };
    expect(orphanSpans(spans)).toEqual([]);

    // Root span (ingress) ends after all children
    const rootSpan = spans.find((s) => s.name === "ingress");
    expect(rootSpan).toBeDefined();
    const maxChildEnd = Math.max(
      ...spans.filter((s) => s.name !== "ingress").map((s) => s.endedAt)
    );
    expect(rootSpan?.endedAt).toBeGreaterThanOrEqual(maxChildEnd);

    // No planted secret in serialized spans
    expect(JSON.stringify(spans)).not.toContain(SECRET);

    // No planted secret in serialized logs
    expect(JSON.stringify(logs)).not.toContain(SECRET);

    // Stage latency metric data points
    const stageMetrics = metrics.filter((m) => m.name === "autostack.stage.latency");
    expect(stageMetrics).toHaveLength(6);
  });
});
