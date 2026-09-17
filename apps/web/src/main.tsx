import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { logBuild } from "./build";
import "./index.css";

// Before rendering, so the build is logged even if something below throws.
logBuild();

const root = document.getElementById("root");
if (root === null) {
  throw new Error("index.html is missing #root.");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
