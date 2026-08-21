import { parentPort, workerData } from "node:worker_threads";

import { openDatabase } from "../../src/database.ts";

parentPort.postMessage({ status: "ready" });

parentPort.once("message", () => {
  try {
    const database = openDatabase({ filePath: workerData.filePath });
    const count = database.connection.prepare("SELECT COUNT(*) AS count FROM run_summaries").get();
    database.close();
    parentPort.postMessage({ status: "completed", count: count.count });
  } catch (error) {
    parentPort.postMessage({
      status: "failed",
      message: error instanceof Error ? error.message : "Unknown projection error."
    });
  }
});
