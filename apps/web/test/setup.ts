/**
 * Unmounts anything a test rendered. Otherwise components persist between
 * tests and a query that should match one element finds several.
 */

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
