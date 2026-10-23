import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, validateConfig } from "../src/config.ts";

const env = (values, fn) => {
  const keys = ["OPENAI_ADS_API_KEY", "OPENAI_ADS_ACCOUNT_ID", "OPENAI_ADS_ENABLE_WRITES", "OPENAI_ADS_ENABLE_ACTIVATION"];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, values);
  try { return fn(); } finally { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
};

test("invalid configuration is refused with an actionable error that never repeats the key", () => {
  for (const value of [{}, { apiKey: "private-key", accountId: "" }, { apiKey: "private-key", accountId: "123" }, { apiKey: "private key", accountId: "adacct_abc" }, { apiKey: "", accountId: "adacct_abc" }]) {
    assert.throws(() => validateConfig(value), e => /OPENAI_ADS_API_KEY/.test(e.message) && !e.message.includes("private"));
  }
});

test("writes and activation are off unless set to exactly true", () => {
  const base = { OPENAI_ADS_API_KEY: "fixture-key", OPENAI_ADS_ACCOUNT_ID: "adacct_abc" };
  env(base, () => assert.deepEqual(loadConfig(), { apiKey: "fixture-key", accountId: "adacct_abc", enableWrites: false, enableActivation: false }));
  env({ ...base, OPENAI_ADS_ENABLE_WRITES: "true" }, () => assert.equal(loadConfig().enableWrites, true));
  for (const value of ["1", "yes", "TRUE", "on"]) env({ ...base, OPENAI_ADS_ENABLE_WRITES: value }, () => assert.throws(() => loadConfig(), /must be true or false/));
  env({ ...base, OPENAI_ADS_ENABLE_ACTIVATION: "true" }, () => assert.throws(() => loadConfig(), /requires OPENAI_ADS_ENABLE_WRITES=true/));
  env({ ...base, OPENAI_ADS_ENABLE_WRITES: "true", OPENAI_ADS_ENABLE_ACTIVATION: "true" }, () => assert.equal(loadConfig().enableActivation, true));
});
