import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { logBuild } from "./build";
import { installPointerFocus } from "./lib/pointer-focus";
import { isPrivacyPath, PRIVACY_POLICY_URL } from "./routes";
import "./index.css";

// The policy lives on lunox.work; older links name /privacy here.
if (isPrivacyPath(window.location.pathname)) {
  window.location.replace(PRIVACY_POLICY_URL);
}

// Before rendering, so the build is logged even if something below throws.
logBuild();
// Before rendering too, so no focus call the app makes can miss it.
installPointerFocus();

const root = document.getElementById("root");
if (root === null) {
  throw new Error("index.html is missing #root.");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
