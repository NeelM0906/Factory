import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@autostack/ui/tokens.css";
import "@autostack/ui/shell.css";
import "./app.css";

import { App } from "./app.js";

const rootElement = document.querySelector("#root");
if (rootElement === null) throw new TypeError("AutoStack root element is missing.");

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
