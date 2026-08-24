import { HostReadinessRecordSchema, type HostReadinessRecord } from "@autostack/contracts";

export interface ReadinessWriter {
  writeOnce(record: HostReadinessRecord): Promise<void> | void;
}

export interface BoundAddress {
  readonly address: string;
  readonly family: string;
  readonly port: number;
}

export interface ReadinessPublisher {
  publish(address: BoundAddress, pid: number): Promise<HostReadinessRecord>;
}

export const createReadinessPublisher = (writer: ReadinessWriter): ReadinessPublisher => {
  let published = false;
  return {
    async publish(address, pid) {
      if (published) throw new TypeError("Readiness was already published.");
      if (
        address.address !== "127.0.0.1" ||
        address.family !== "IPv4" ||
        !Number.isInteger(address.port) ||
        address.port < 1 ||
        address.port > 65_535
      ) {
        throw new TypeError("Host listener is not verified loopback.");
      }
      const record = HostReadinessRecordSchema.parse({
        schemaVersion: 1,
        type: "runtime.ready",
        service: "autostack-host-daemon",
        pid,
        origin: `http://127.0.0.1:${address.port}`
      });
      published = true;
      await writer.writeOnce(record);
      return record;
    }
  };
};
