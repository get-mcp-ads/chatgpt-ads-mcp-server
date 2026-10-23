#!/usr/bin/env node
/** Checks the local setup without contacting ChatGPT Ads and without printing any secret. */
const present = name => typeof process.env[name] === "string" && process.env[name].trim().length > 0;
const flag = name => (process.env[name] ?? "").trim();

let runtimeWarning;
try { ({ nodeRuntimeWarning: runtimeWarning } = await import("../dist/index.js")); } catch { runtimeWarning = undefined; }
const warning = runtimeWarning ? runtimeWarning() : "Run npm run build first to include the Node.js runtime check.";
if (warning) console.error(`[chatgpt-ads-mcp] ${warning}`);

const accountId = flag("OPENAI_ADS_ACCOUNT_ID");
const problems = [];
if (!present("OPENAI_ADS_API_KEY")) problems.push("Set OPENAI_ADS_API_KEY to an Advertiser API key from Ads Manager settings.");
else if (/\s/.test(process.env.OPENAI_ADS_API_KEY.trim())) problems.push("OPENAI_ADS_API_KEY contains whitespace.");
if (!/^adacct_[A-Za-z0-9_-]{1,128}$/.test(accountId)) problems.push("Set OPENAI_ADS_ACCOUNT_ID to the adacct_ ID of the account the key belongs to.");
for (const name of ["OPENAI_ADS_ENABLE_WRITES", "OPENAI_ADS_ENABLE_ACTIVATION"]) if (!["", "true", "false"].includes(flag(name))) problems.push(`${name} must be true or false.`);
if (flag("OPENAI_ADS_ENABLE_ACTIVATION") === "true" && flag("OPENAI_ADS_ENABLE_WRITES") !== "true") problems.push("OPENAI_ADS_ENABLE_ACTIVATION=true also requires OPENAI_ADS_ENABLE_WRITES=true.");

const result = {
  package: "@getmcpads/chatgpt-ads-mcp-server",
  ok: problems.length === 0,
  node: { version: process.versions.node, warning: warning ?? null },
  configuration: {
    OPENAI_ADS_API_KEY: present("OPENAI_ADS_API_KEY") ? "set" : "missing",
    OPENAI_ADS_ACCOUNT_ID: accountId ? "set" : "missing",
    writes: flag("OPENAI_ADS_ENABLE_WRITES") === "true",
    activation: flag("OPENAI_ADS_ENABLE_ACTIVATION") === "true",
  },
  problems,
  note: "This check does not contact ChatGPT Ads. Call openai_ads_get_account first to verify the key and account.",
};
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
