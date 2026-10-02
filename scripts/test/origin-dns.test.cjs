const { execFileSync } = require("node:child_process");
const { test } = require("node:test");
const { resolve } = require("node:path");

test("origin DNS only advertises API service tasks", () => {
  execFileSync(
    "python3",
    [resolve(__dirname, "../../infra/lambda/test_origin_dns.py")],
    {
      stdio: "pipe",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    },
  );
});
