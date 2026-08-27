import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { app, BrowserWindow, dialog, safeStorage, utilityProcess } from "electron";

import { createHostDaemonClient } from "../../../control-plane/src/host-daemon-client.js";

interface VerifierDescriptor {
  readonly schemaVersion: 1;
  readonly userDataRoot: string;
  readonly repositoryPath: string;
  readonly apiToken: string;
}

interface TrackedChild {
  readonly kill: () => boolean;
}

let hostOrigin: string | undefined;
let hostToken: string | undefined;
const messageTrace: string[] = [];

const descriptorPath = process.env.AUTOSTACK_E2E_DESCRIPTOR;
if (descriptorPath === undefined) throw new TypeError("missing verifier descriptor");
const descriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as VerifierDescriptor;
if (
  descriptor.schemaVersion !== 1 ||
  !descriptor.userDataRoot.startsWith("/") ||
  !descriptor.repositoryPath.startsWith("/") ||
  descriptor.apiToken.length !== 43
) {
  throw new TypeError("invalid verifier descriptor");
}
await unlink(descriptorPath);
delete process.env.AUTOSTACK_E2E_DESCRIPTOR;

if (app.getPath("userData") !== descriptor.userDataRoot) {
  throw new TypeError("verifier user-data profile was not isolated before startup");
}
app.setPath("userData", descriptor.userDataRoot);
if (app.getPath("userData") !== descriptor.userDataRoot) {
  throw new TypeError("verifier user-data profile changed after isolation");
}
const ciphertext = Buffer.from(`autostack-e2e:${descriptor.apiToken}`, "utf8");
const privateRoot = join(descriptor.userDataRoot, "private");
await mkdir(privateRoot, { recursive: true, mode: 0o700 });
await chmod(privateRoot, 0o700);
await writeFile(join(privateRoot, "api-token.enc"), ciphertext, { mode: 0o600 });
await chmod(join(privateRoot, "api-token.enc"), 0o600);
Object.defineProperties(safeStorage, {
  isEncryptionAvailable: { configurable: true, value: () => true },
  encryptString: { configurable: true, value: () => Buffer.from(ciphertext) },
  decryptString: {
    configurable: true,
    value: (value: Buffer) => {
      if (!value.equals(ciphertext)) throw new TypeError("invalid verifier ciphertext");
      return descriptor.apiToken;
    }
  }
});
Object.defineProperty(dialog, "showOpenDialog", {
  configurable: true,
  value: async () => ({ canceled: false, filePaths: [descriptor.repositoryPath] })
});

const children = new Map<"host" | "control-plane", TrackedChild>();
const fork = utilityProcess.fork.bind(utilityProcess);
Object.defineProperty(utilityProcess, "fork", {
  configurable: true,
  value: (...args: Parameters<typeof utilityProcess.fork>) => {
    const [modulePath, childArgs = [], options = {}] = args;
    const child = fork(modulePath, childArgs, { ...options, stdio: "pipe" });
    const service = modulePath.endsWith("/host.js") ? "host" : "control-plane";
    const originalPostMessage = child.postMessage.bind(child);
    Object.defineProperty(child, "postMessage", {
      configurable: true,
      value: (message: unknown, transfer?: Electron.MessagePortMain[]) => {
        const type =
          message !== null && typeof message === "object" && "type" in message
            ? String(message.type)
            : "unknown";
        messageTrace.push(`${service}:to:${type}`);
        return originalPostMessage(message, transfer);
      }
    });
    child.on("message", (message) => {
      const type =
        message !== null && typeof message === "object" && "type" in message
          ? String(message.type)
          : message !== null && typeof message === "object" && "service" in message
            ? "readiness"
            : "unknown";
      const ok =
        message !== null && typeof message === "object" && "ok" in message
          ? `:${String(message.ok)}`
          : "";
      messageTrace.push(`${service}:from:${type}${ok}`);
    });
    if (modulePath.endsWith("/host.js")) {
      children.set("host", child);
      const postMessage = child.postMessage.bind(child);
      Object.defineProperty(child, "postMessage", {
        configurable: true,
        value: (message: unknown, transfer?: Electron.MessagePortMain[]) => {
          if (
            message !== null &&
            typeof message === "object" &&
            "type" in message &&
            message.type === "host.bootstrap" &&
            "hostToken" in message &&
            typeof message.hostToken === "string"
          ) {
            hostToken = message.hostToken;
          }
          return postMessage(message, transfer);
        }
      });
      child.on("message", (message) => {
        const candidate = message as unknown;
        if (
          candidate !== null &&
          typeof candidate === "object" &&
          "service" in candidate &&
          candidate.service === "autostack-host-daemon" &&
          "origin" in candidate &&
          typeof candidate.origin === "string"
        ) {
          hostOrigin = candidate.origin;
        }
      });
    }
    if (modulePath.endsWith("/control-plane.js")) children.set("control-plane", child);
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[autostack-e2e-utility] ${chunk.toString("utf8")}`);
    });
    // stdout was never forwarded, so a child that reports on stdout rather than stderr stayed
    // invisible. Both streams are piped by the fork options above; read both.
    child.stdout?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[autostack-e2e-utility-out] ${chunk.toString("utf8")}`);
    });
    child.once("exit", (code) => {
      process.stderr.write(
        `[autostack-e2e-utility-exit] ${modulePath.endsWith("/host.js") ? "host" : "control-plane"}:${String(code)}\n`
      );
    });
    return child;
  }
});

Object.defineProperty(globalThis, "__autostackVerifier", {
  configurable: false,
  enumerable: false,
  value: Object.freeze({
    startupFailed(error: unknown) {
      const cause =
        error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
      const message =
        error instanceof Error ? `${error.name}: ${error.message}${cause}` : "unknown error";
      process.stderr.write(`[autostack-e2e-startup] ${message}\n`);
    },
    audit() {
      const window = BrowserWindow.getAllWindows()[0];
      const preferences = (
        window?.webContents as Electron.WebContents & {
          getLastWebPreferences(): Electron.WebPreferences;
        }
      )?.getLastWebPreferences();
      return {
        userDataRoot: app.getPath("userData"),
        windowCount: BrowserWindow.getAllWindows().length,
        hostActive: children.has("host"),
        controlPlaneActive: children.has("control-plane"),
        preferences: {
          sandbox: preferences?.sandbox,
          contextIsolation: preferences?.contextIsolation,
          nodeIntegration: preferences?.nodeIntegration,
          nodeIntegrationInWorker: preferences?.nodeIntegrationInWorker,
          nodeIntegrationInSubFrames: preferences?.nodeIntegrationInSubFrames,
          webSecurity: preferences?.webSecurity,
          allowRunningInsecureContent: preferences?.allowRunningInsecureContent,
          webviewTag: preferences?.webviewTag
        }
      };
    },
    kill(service: "host" | "control-plane") {
      return children.get(service)?.kill() ?? false;
    },
    async diagnoseHostInspection() {
      if (hostOrigin === undefined || hostToken === undefined)
        return { status: 0, code: "unready" };
      const response = await fetch(`${hostOrigin}/v1/repositories/inspect`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${hostToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ sourcePath: descriptor.repositoryPath, baseRef: "main" })
      });
      const body = (await response.json().catch(() => ({}))) as { code?: unknown };
      return {
        status: response.status,
        code: typeof body.code === "string" ? body.code : "ok",
        contentType: response.headers.get("content-type") ?? "missing"
      };
    },
    async diagnoseHostClientInspection() {
      if (hostOrigin === undefined || hostToken === undefined) return "unready";
      try {
        await createHostDaemonClient({
          origin: hostOrigin,
          token: hostToken,
          fetch
        }).inspectRepository({ sourcePath: descriptor.repositoryPath, baseRef: "main" });
        return "ok";
      } catch (error) {
        return error instanceof Error ? error.name : "unknown";
      }
    },
    messageTrace() {
      return [...messageTrace];
    },
    resize(width: number, height: number) {
      const window = BrowserWindow.getAllWindows()[0];
      window?.setMinimumSize(0, 0);
      window?.setContentSize(width, height);
    },
    quit() {
      app.quit();
    }
  })
});

const productionMain = join(import.meta.dirname, "..", "dist", "main", "index.js");
await import(pathToFileURL(productionMain).href);
