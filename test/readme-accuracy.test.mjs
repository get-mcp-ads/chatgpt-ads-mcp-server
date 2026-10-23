/**
 * The README documents every tool and resource by name. A tool renamed in the
 * code and not in the README is a documentation bug, and this test fails on it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const READS = 30, WRITES = 28, RESOURCES = 1;

async function introspect() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/cli.js"],
    env: { ...process.env, OPENAI_ADS_API_KEY: "key-for-listing", OPENAI_ADS_ACCOUNT_ID: "adacct_listing", OPENAI_ADS_ENABLE_WRITES: "true" },
    stderr: "pipe",
  });
  const client = new Client({ name: "readme-check", version: "1" }, { capabilities: {} });
  await client.connect(transport);
  const definitions = (await client.listTools()).tools;
  const resources = (await client.listResources()).resources.map(r => r.uri);
  await client.close();
  return { tools: definitions.map(t => t.name), resources, definitions };
}

const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const surface = await introspect();

test("README documents every tool the server exposes and invents none", () => {
  const cited = new Set([...README.matchAll(/`(openai_ads_[a-z_]+)`/g)].map(m => m[1]));
  const undocumented = surface.tools.filter(t => !cited.has(t));
  assert.deepEqual(undocumented, [], `Tools missing from README: ${undocumented.join(", ")}`);
  const invented = [...cited].filter(c => !surface.tools.includes(c));
  assert.deepEqual(invented, [], `README cites tools that do not exist: ${invented.join(", ")}`);
});

test("README documents every resource the server exposes and invents none", () => {
  const cited = new Set([...README.matchAll(/`(openai-ads:\/\/[a-z0-9-]+)`/g)].map(m => m[1]));
  assert.deepEqual(surface.resources.filter(r => !cited.has(r)), [], "Resources missing from README");
  assert.deepEqual([...cited].filter(c => !surface.resources.includes(c)), [], "README cites resources that do not exist");
});

test("README, package and registry counts match the code", () => {
  const writes = surface.definitions.filter(t => !t.annotations.readOnlyHint).map(t => t.name);
  const reads = surface.tools.filter(t => !writes.includes(t));
  assert.equal(reads.length, READS, "read tool count changed, update the README");
  assert.equal(writes.length, WRITES, "write tool count changed, update the README");
  assert.equal(surface.resources.length, RESOURCES, "resource count changed, update the README");
  assert.match(README, new RegExp(`\\*\\*${READS} read tools\\*\\*`));
  assert.match(README, new RegExp(`\\*\\*${WRITES} write tools\\*\\*`));
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const server = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));
  for (const description of [pkg.description, server.description]) assert.match(description, new RegExp(`${READS} read tools, ${WRITES} `));
});

test("every documented environment variable is real and declared", () => {
  const cited = new Set([...README.matchAll(/`(OPENAI_ADS_[A-Z_]+)`/g)].map(m => m[1]));
  const server = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));
  const declared = server.packages.flatMap(p => p.environmentVariables ?? []).map(v => v.name).sort();
  assert.deepEqual([...cited].sort(), declared);
});

test("published prose uses no em dashes", () => {
  const files = ["README.md", "SECURITY.md", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "CHANGELOG.md", "RELEASING.md", "SOURCE_SYNC.md", "NOTICE", ".env.example", "server.json", "package.json"];
  const walk = (dir, acc = []) => {
    for (const entry of readdirSync(new URL(`../${dir}/`, import.meta.url), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${dir}/${entry.name}`, acc);
      else if (/\.(ts|mjs)$/.test(entry.name)) acc.push(`${dir}/${entry.name}`);
    }
    return acc;
  };
  const offenders = [];
  for (const file of [...files, ...walk("src"), ...walk("scripts")]) {
    readFileSync(new URL(`../${file}`, import.meta.url), "utf8").split("\n").forEach((line, i) => { if (line.includes("—")) offenders.push(`${file}:${i + 1}`); });
  }
  assert.deepEqual(offenders, [], `Em dashes are not used in this project. Rewrite the sentence instead of swapping the character. Found at: ${offenders.join(", ")}`);
});
