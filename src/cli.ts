#!/usr/bin/env node
/**
 * chatgpt-ads-mcp-server: an open-source MCP server for the ChatGPT Ads Advertiser API.
 * Copyright 2026 GetMCPAds. https://www.getmcpads.com
 * SPDX-License-Identifier: Apache-2.0
 *
 * stdout carries the MCP protocol. Every diagnostic goes to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { loadConfig } from "./config.js";
import { nodeRuntimeWarning } from "./runtime-check.js";

const warning = nodeRuntimeWarning();
if (warning) console.error(`[chatgpt-ads-mcp] ${warning}`);
try {
  await createServer(loadConfig()).connect(new StdioServerTransport());
} catch (error) {
  console.error(`[chatgpt-ads-mcp] ${error instanceof Error ? error.message : "ChatGPT Ads server failed to start."}`);
  process.exitCode = 1;
}
