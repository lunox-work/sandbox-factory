// Builds the E2B template the `e2b` evaluation provider runs jobs in:
// Node 22 (the sandbox contract needs 22.12 or later; E2B's `base` ships
// Node 20), the default `user` in /home/user, no start command.
//
//   E2B_API_KEY=… node apps/worker/scripts/e2b-template.mjs [name]
//
// Then set E2B_TEMPLATE (worker) or WORKER_E2B_TEMPLATE (CD) to the name.
import { Template, defaultBuildLogger } from "e2b";

const name = process.argv[2] ?? "sandbox-factory-node22";
if (!process.env.E2B_API_KEY) {
  console.error("E2B_API_KEY is required.");
  process.exit(2);
}

const template = Template()
  .fromNodeImage("22")
  .setUser("user")
  .setWorkdir("/home/user");

const info = await Template.build(template, name, {
  cpuCount: 2,
  memoryMB: 2048,
  onBuildLogs: defaultBuildLogger(),
});
console.log(`Built ${name}: ${JSON.stringify(info)}`);
