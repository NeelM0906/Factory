import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  DesktopRepositoryPickerResponseSchema,
  DesktopCommandStreamRequestSchema,
  DesktopRuntimeStatusSchema,
  GuardianLaunchDescriptorSchema,
  HostRuntimeManifestSchema,
  type DesktopRuntimeStatus,
  type GuardianLaunchDescriptor
} from "@autostack/contracts";
import { app, BrowserWindow, dialog, ipcMain, safeStorage, session } from "electron";

import { CredentialStore } from "./credential-store.js";
import { followDesktopCommand } from "./command-subscription.js";
import { createDesktopRequestHandler } from "./desktop-request-handler.js";
import { createElectronUtilityLauncher } from "./electron-utility-launcher.js";
import { createNavigationPolicy } from "./navigation-policy.js";
import { RepositoryCapabilityRegistry } from "./repository-capabilities.js";
import { RuntimeSupervisor } from "./runtime-supervisor.js";
import { createWindowConfiguration } from "./window.js";

let mainWindow: BrowserWindow | undefined;
let supervisor: RuntimeSupervisor | undefined;
let apiToken: string | undefined;
let runtimeStatus: DesktopRuntimeStatus = { status: "stopped" };
let quitting = false;
const repositories = new RepositoryCapabilityRegistry();
const commandSubscriptions = new Map<string, AbortController>();

const rendererUrl = (): string => {
  const development = process.env.ELECTRON_RENDERER_URL;
  if (development !== undefined) {
    const url = new URL(development);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port.length === 0) {
      throw new TypeError("desktop development renderer must use numeric loopback");
    }
    return url.toString();
  }
  return pathToFileURL(join(import.meta.dirname, "../renderer/index.html")).toString();
};

const trustedSender = (frameUrl: string): boolean => {
  try {
    const expected = new URL(rendererUrl());
    const candidate = new URL(frameUrl);
    return expected.protocol === "file:"
      ? candidate.href === expected.href
      : candidate.origin === expected.origin;
  } catch {
    return false;
  }
};

const assertSender = (event: Electron.IpcMainInvokeEvent): BrowserWindow => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (
    window === null ||
    window !== mainWindow ||
    event.senderFrame !== window.webContents.mainFrame ||
    !trustedSender(event.senderFrame.url)
  ) {
    throw new TypeError("untrusted desktop IPC sender");
  }
  return window;
};

const publishRuntimeStatus = (status: DesktopRuntimeStatus): void => {
  runtimeStatus = DesktopRuntimeStatusSchema.parse(status);
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("autostack:runtime-status-changed", runtimeStatus);
  }
};

const registerIpc = (): void => {
  const handleRequest = createDesktopRequestHandler({
    authorize: assertSender,
    getOrigin: () => supervisor?.controlPlaneOrigin(),
    getToken: () => apiToken,
    localDispatcher: {
      request: async (request) => {
        if (supervisor === undefined) {
          throw new Error("Desktop local-operation dispatcher unavailable.");
        }
        return (await supervisor.dispatchLocal(request)) as never;
      }
    }
  });
  ipcMain.handle("autostack:runtime-status", (event) => {
    assertSender(event);
    return DesktopRuntimeStatusSchema.parse(runtimeStatus);
  });
  ipcMain.handle("autostack:pick-repository", async (event) => {
    const window = assertSender(event);
    const selection = await dialog.showOpenDialog(window, {
      title: "Choose a repository",
      properties: ["openDirectory"]
    });
    if (selection.canceled || selection.filePaths[0] === undefined) {
      return DesktopRepositoryPickerResponseSchema.parse({ repository: null });
    }
    const repository = await repositories.register(selection.filePaths[0], realpath);
    return DesktopRepositoryPickerResponseSchema.parse({ repository });
  });
  ipcMain.handle("autostack:request", handleRequest);
  ipcMain.handle("autostack:subscribe-command", (event, candidate) => {
    const window = assertSender(event);
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      !("subscriptionId" in candidate) ||
      typeof candidate.subscriptionId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(candidate.subscriptionId) ||
      !("request" in candidate)
    ) {
      throw new TypeError("invalid desktop subscription");
    }
    const request = DesktopCommandStreamRequestSchema.parse(candidate.request);
    const origin = supervisor?.controlPlaneOrigin();
    if (origin === undefined) throw new Error("Desktop runtime unavailable.");
    const controller = new AbortController();
    commandSubscriptions.get(candidate.subscriptionId)?.abort();
    commandSubscriptions.set(candidate.subscriptionId, controller);
    void followDesktopCommand({
      origin,
      getToken: () => apiToken,
      request,
      signal: controller.signal,
      emit: (item) => window.webContents.send(`autostack:command:${candidate.subscriptionId}`, item)
    })
      .catch(() => {
        if (!controller.signal.aborted) {
          publishRuntimeStatus({
            status: "degraded",
            message: "A local command subscription could not be resumed."
          });
        }
      })
      .finally(() => {
        if (commandSubscriptions.get(candidate.subscriptionId) === controller) {
          commandSubscriptions.delete(candidate.subscriptionId);
        }
      });
  });
  ipcMain.handle("autostack:detach-command", (event, candidate) => {
    assertSender(event);
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      !("subscriptionId" in candidate) ||
      typeof candidate.subscriptionId !== "string"
    ) {
      throw new TypeError("invalid desktop subscription");
    }
    commandSubscriptions.get(candidate.subscriptionId)?.abort();
    commandSubscriptions.delete(candidate.subscriptionId);
  });
};

const createWindow = async (): Promise<BrowserWindow> => {
  const preload = join(import.meta.dirname, "../preload/index.cjs");
  const target = rendererUrl();
  const window = new BrowserWindow(createWindowConfiguration(preload));
  const policy = createNavigationPolicy({
    productionUrl: pathToFileURL(join(import.meta.dirname, "../renderer/index.html")).toString(),
    ...(process.env.ELECTRON_RENDERER_URL === undefined
      ? {}
      : { developmentOrigin: process.env.ELECTRON_RENDERER_URL })
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false)
  );
  session.defaultSession.on("will-download", (event) => event.preventDefault());
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' http://127.0.0.1:*; object-src 'none'; base-uri 'none'; frame-src 'none'"
        ]
      }
    });
  });
  window.webContents.setWindowOpenHandler(policy.windowOpen);
  window.webContents.on("will-navigate", (event, url) => policy.navigation(url, event));
  window.once("ready-to-show", () => window.show());
  await window.loadURL(target);
  return window;
};

const loadGuardianDescriptor = async (): Promise<GuardianLaunchDescriptor> => {
  const buildRoot = await realpath(join(import.meta.dirname, ".."));
  const manifestBytes = await readFile(join(buildRoot, "runtime-manifest.json"));
  const manifest = HostRuntimeManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
  return GuardianLaunchDescriptorSchema.parse({
    electronExecutable: manifest.electronExecutable,
    guardianModule: manifest.guardianModule,
    nativeDirectory: manifest.nativeDirectory,
    desktopBuildRoot: manifest.desktopBuildRoot,
    runtimeManifestDigest: createHash("sha256").update(manifestBytes).digest("hex"),
    electronVersion: manifest.electronVersion,
    nodePtyVersion: manifest.nodePtyVersion
  });
};

const preparePrivateDirectory = async (path: string): Promise<string> => {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  return await realpath(path);
};

const start = async (): Promise<void> => {
  const privateRoot = await preparePrivateDirectory(join(app.getPath("userData"), "private"));
  const store = new CredentialStore({
    root: privateRoot,
    protector: {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (value) => safeStorage.encryptString(value),
      decrypt: (value) => safeStorage.decryptString(value)
    }
  });
  apiToken = await store.loadOrCreate();
  const hostDataRoot = await preparePrivateDirectory(join(privateRoot, "host"));
  const controlPlaneDataDirectory = await preparePrivateDirectory(
    join(privateRoot, "control-plane")
  );
  registerIpc();
  supervisor = new RuntimeSupervisor({
    launch: createElectronUtilityLauncher({
      resolveRepository: (id) => repositories.resolve(id),
      authorizeTerminalEvidence: async (request) => {
        if (supervisor === undefined) {
          throw new Error("Host terminal evidence authority unavailable.");
        }
        await supervisor.authorizeTerminalEvidence(request);
      }
    }),
    onStatus: publishRuntimeStatus
  });
  await supervisor.start({
    instanceId: `runtime_${randomUUID()}`,
    apiTokenDigest: createHash("sha256").update(apiToken, "utf8").digest("hex"),
    hostDataRoot,
    controlPlaneDataDirectory,
    guardian: await loadGuardianDescriptor()
  });
  mainWindow = await createWindow();
};

app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  repositories.clear();
  for (const controller of commandSubscriptions.values()) controller.abort();
  commandSubscriptions.clear();
  const stopping = supervisor?.stop() ?? Promise.resolve();
  void stopping
    .catch(() => undefined)
    .finally(() => {
      apiToken = undefined;
      app.exit(0);
    });
});
void app
  .whenReady()
  .then(start)
  .catch((error: unknown) => {
    const verifier = Reflect.get(globalThis, "__autostackVerifier");
    if (
      verifier !== null &&
      typeof verifier === "object" &&
      "startupFailed" in verifier &&
      typeof verifier.startupFailed === "function"
    ) {
      Reflect.apply(verifier.startupFailed, verifier, [error]);
    }
    publishRuntimeStatus({ status: "degraded", message: "Desktop startup failed closed." });
    apiToken = undefined;
    app.quit();
  });
