import {
  ControlPlaneReadinessRecordSchema,
  type ControlPlaneReadinessRecord
} from "@autostack/contracts";

export interface ReadinessWriter {
  postMessage(value: unknown): void;
}

export const createControlPlaneReadiness = (
  address: unknown,
  pid: number
): ControlPlaneReadinessRecord => {
  if (
    address === null ||
    typeof address !== "object" ||
    !("address" in address) ||
    !("port" in address) ||
    address.address !== "127.0.0.1" ||
    typeof address.port !== "number"
  )
    throw new TypeError("Control-plane listener address is invalid.");
  return ControlPlaneReadinessRecordSchema.parse({
    schemaVersion: 1,
    type: "runtime.ready",
    service: "autostack-control-plane",
    pid,
    origin: `http://127.0.0.1:${address.port}`
  });
};

export const publishControlPlaneReadiness = (
  writer: ReadinessWriter,
  address: unknown,
  pid = process.pid
): ControlPlaneReadinessRecord => {
  const readiness = createControlPlaneReadiness(address, pid);
  writer.postMessage(readiness);
  return readiness;
};
