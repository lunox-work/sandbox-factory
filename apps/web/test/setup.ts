/**
 * Unmounts anything a test rendered.
 *
 * Without this, components persist between tests and a query that should
 * match one element finds several — a failure mode that looks like a bug in
 * the component rather than in the harness.
 */

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
