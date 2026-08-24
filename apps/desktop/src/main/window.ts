import type { BrowserWindowConstructorOptions } from "electron";

export const createWindowConfiguration = (preload: string): BrowserWindowConstructorOptions => ({
  width: 1_440,
  height: 960,
  minWidth: 1_024,
  minHeight: 720,
  show: false,
  backgroundColor: "#0f1218",
  webPreferences: {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
    preload
  }
});
