import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { createServer } from "../dist/index.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const fixture = { apiKey: "metadata-fixture", accountId: "adacct_fixture" };
async function connect(enableWrites, callback) {
  const server = createServer({ ...fixture, enableWrites, enableActivation: false });
  const client = new Client({ name: "quality-contract", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try { await callback(client, server); } finally { await client.close(); await server.close(); }
}

test("metadata is complete over MCP; write tools require explicit opt-in", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Metadata must not access a provider"); };
  try {
    for (const enabled of [false, true]) await connect(enabled, async client => {
      const tools = (await client.listTools()).tools;
      assert.equal(new Set(tools.map(t => t.name)).size, tools.length, "duplicate tools");
      for (const tool of tools) {
        assert.ok(tool.name.startsWith("openai_ads_"), tool.name);
        assert.ok(tool.description.length > 20, tool.name);
        assert.ok(tool.outputSchema?.required.includes("result"), tool.name);
        assert.equal(typeof tool.annotations?.readOnlyHint, "boolean", tool.name);
        assert.equal(tool.annotations.openWorldHint, true, tool.name);
        if (!enabled) assert.equal(tool.annotations.readOnlyHint, true, tool.name);
        if (!tool.annotations.readOnlyHint) {
          assert.ok(tool.inputSchema.properties.confirm, tool.name);
          assert.equal(tool.inputSchema.properties.confirm.default, false, tool.name);
          assert.equal(tool.annotations.idempotentHint, false, tool.name);
        } else assert.equal(tool.inputSchema.properties.confirm, undefined, tool.name);
        for (const [key, schema] of Object.entries(tool.inputSchema.properties || {})) assert.ok(schema.description, `${tool.name}.${key}`);
      }
      assert.equal(client.getServerVersion().websiteUrl, pkg.homepage);
      assert.equal(client.getServerVersion().version, pkg.version);
    });
  } finally { globalThis.fetch = original; }
});

test("unknown or malformed arguments are refused over MCP before any request", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("No request may be sent"); };
  try {
    await connect(true, async client => {
      for (const args of [{ adAccountId: "adacct_fixture", unexpected: true }, { adAccountId: "adacct_fixture", campaignId: "../ad_account" }, {}]) {
        const out = await client.callTool({ name: args.campaignId ? "openai_ads_get_campaign" : "openai_ads_get_campaigns", arguments: args });
        assert.equal(out.isError, true, JSON.stringify(args));
      }
      const tool = (await client.listTools()).tools.find(t => t.name === "openai_ads_get_campaigns");
      assert.equal(tool.inputSchema.additionalProperties, false);
    });
  } finally { globalThis.fetch = original; }
  assert.equal(calls, 0);
});

test("structured output preserves text, JSON arrays and errors through the SDK", async () => {
  await connect(false, async (client, server) => {
    server.tool("quality_fixture", "Fixture that checks the actual SDK response contract.", { mode: z.enum(["json", "text", "error"]).describe("Fixture response type.") }, async ({ mode }) => ({ ...(mode === "error" ? { isError: true } : {}), content: [{ type: "text", text: mode === "json" ? '[{"spend":0,"currency":"EUR"}]' : mode }] }));
    for (const mode of ["json", "text", "error"]) {
      const out = await client.callTool({ name: "quality_fixture", arguments: { mode } });
      if (mode === "error") { assert.equal(out.isError, true); assert.equal(out.structuredContent, undefined); }
      else { assert.equal(out.isError, undefined); assert.deepEqual(out.structuredContent.result, mode === "json" ? [{ spend: 0, currency: "EUR" }] : "text"); }
    }
  });
});
