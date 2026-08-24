import { contextBridge, ipcRenderer } from "electron";

import { createDesktopBridge } from "./bridge.js";

contextBridge.exposeInMainWorld("autostack", createDesktopBridge(ipcRenderer));
