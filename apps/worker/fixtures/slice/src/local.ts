import { run } from "./app.js";

export const go = () =>
  run({ name: "x", retries: 1, nested: { enabled: true } });
