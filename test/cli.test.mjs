/** stdout is the MCP channel. Startup errors and runtime warnings go to stderr only. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("OPENAI_ADS_")));

test("a missing configuration exits with an actionable stderr message and an empty stdout", () => {
  const run = spawnSync(process.execPath, [cli], { env: { ...clean, OPENAI_ADS_API_KEY: "private-cli-key" }, input: "", encoding: "utf8", timeout: 15000 });
  assert.equal(run.status, 1);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /OPENAI_ADS_ACCOUNT_ID/);
  assert.doesNotMatch(run.stderr, /private-cli-key/);
});
