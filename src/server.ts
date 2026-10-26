/**
 * chatgpt-ads-mcp-server: an open-source MCP server for the ChatGPT Ads Advertiser API.
 * Copyright 2026 GetMCPAds. https://www.getmcpads.com
 * SPDX-License-Identifier: Apache-2.0
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { installToolQuality } from "./tool-quality.js";
import { validateConfig, type OpenAIAdsConfig } from "./config.js";
import { OpenAIAdsClient, OpenAIAdsError } from "./client.js";
import { MemoryMutationStore, OpenAIAdsMutations } from "./mutations.js";
import { registerOpenAIAdsReads } from "./tools.js";
import { registerOpenAINative } from "./native-tools.js";
import type { Collector, ToolContext } from "./context.js";

export const PACKAGE_VERSION = "1.0.1";

export function createServer(input: OpenAIAdsConfig): McpServer {
  const config = validateConfig(input);
  const server = new McpServer({ name: "chatgpt-ads-mcp", version: PACKAGE_VERSION, title: "ChatGPT Ads", websiteUrl: "https://www.getmcpads.com/tools/chatgpt-ads", icons: [{ src: "https://mcp.getmcpads.com/icon.svg", mimeType: "image/svg+xml" }] });
  installToolQuality(server);
  const client = new OpenAIAdsClient(config);
  const mutations = new OpenAIAdsMutations({
    store: new MemoryMutationStore(),
    authorize: (accountId, apply) => {
      client.scope(accountId);
      if (apply && !config.enableWrites) throw new OpenAIAdsError(403, "WRITES_DISABLED", "ChatGPT Ads writes are disabled. Set OPENAI_ADS_ENABLE_WRITES=true to enable them.");
    },
  });
  const ctx: ToolContext = { client, mutations, secret: config.apiKey };
  const collector: Collector = {
    tool: (name, description, shape, handler) => { server.tool(name, description, shape, handler); },
    resource: (name, uri, description, read) => { server.registerResource(name, uri, { description, mimeType: "application/json" }, read); },
  };
  registerOpenAIAdsReads(collector, ctx);
  if (config.enableWrites) registerOpenAINative(collector, ctx, true);
  return server;
}
