/**
 * chatgpt-ads-mcp-server: an open-source MCP server for the ChatGPT Ads Advertiser API.
 * Copyright 2026 GetMCPAds. https://www.getmcpads.com
 * SPDX-License-Identifier: Apache-2.0
 */
import { z } from "zod";
import type { OpenAIAdsClient } from "./client.js";
import type { OpenAIAdsMutations } from "./mutations.js";
import type { ToolResult } from "./tool-errors.js";
import type { ToolShape } from "./tool-quality.js";

export type Collector = {
  tool(name: string, description: string, shape: ToolShape, handler: (args: Record<string, unknown>) => Promise<ToolResult>): void;
  resource?(name: string, uri: string, description: string, read: () => Promise<{ contents: { uri: string; mimeType: string; text: string }[] }>): void;
};
export type ToolContext = { client: OpenAIAdsClient; mutations: OpenAIAdsMutations; secret: string };

export const accountParam = z.string().regex(/^adacct_[A-Za-z0-9_-]{1,128}$/).describe("The adacct_ ID configured in OPENAI_ADS_ACCOUNT_ID. The API key is scoped to this one account; another ID is refused.");
