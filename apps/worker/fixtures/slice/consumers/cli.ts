import { run } from "../src/app.js";

console.log(run({ name: "cli", retries: 0, nested: { enabled: false } }));
