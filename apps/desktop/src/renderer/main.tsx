import React from "react";
import { createRoot } from "react-dom/client";

import { App, createDesktopApiClient } from "@autostack/client-app";
import "@autostack/client-app/app.css";
import { ThemeProvider } from "@autostack/ui";
import "@autostack/ui/shell.css";
import "@autostack/ui/tokens.css";

import type { AutoStackDesktopBridge } from "../preload/bridge.js";

declare global {
  interface Window {
    readonly autostack: AutoStackDesktopBridge;
  }
}

const desktopClient = createDesktopApiClient({ bridge: window.autostack });

const root = document.getElementById("root");
if (root === null) throw new Error("desktop renderer root is missing");
createRoot(root).render(
  <React.StrictMode>
    <ThemeProvider storage={window.localStorage}>
      <App client={desktopClient} executionAuthorityDisclosure runtimeBridge={window.autostack} />
    </ThemeProvider>
  </React.StrictMode>
);
