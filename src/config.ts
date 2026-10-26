/**
 * chatgpt-ads-mcp-server: an open-source MCP server for the ChatGPT Ads Advertiser API.
 * Copyright 2026 GetMCPAds. https://www.getmcpads.com
 * SPDX-License-Identifier: Apache-2.0
 */
import { z } from "zod";

export const ACCOUNT_ID_PATTERN = /^adacct_[A-Za-z0-9_-]{1,128}$/;

const schema = z.object({
  apiKey: z.string().min(1).max(4096).regex(/^\S+$/),
  accountId: z.string().regex(ACCOUNT_ID_PATTERN),
  enableWrites: z.boolean().prefault(false),
  enableActivation: z.boolean().prefault(false),
}).strict();

export type OpenAIAdsConfig = z.infer<typeof schema>;

const CONFIG_HELP = "Set OPENAI_ADS_API_KEY to the Advertiser API key created in Ads Manager settings and OPENAI_ADS_ACCOUNT_ID to the adacct_ ID of the ad account that key belongs to.";

/** Validates a configuration object. The error never repeats the key. */
export function validateConfig(value: unknown): OpenAIAdsConfig {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`Invalid ChatGPT Ads configuration. ${CONFIG_HELP}`);
  if (result.data.enableActivation && !result.data.enableWrites) throw new Error("OPENAI_ADS_ENABLE_ACTIVATION=true also requires OPENAI_ADS_ENABLE_WRITES=true.");
  return result.data;
}

function flag(name: string): boolean {
  const raw = (process.env[name] ?? "").trim();
  if (raw === "" || raw === "false") return false;
  if (raw === "true") return true;
  throw new Error(`${name} must be true or false.`);
}

/** Reads the configuration from environment variables only. */
export function loadConfig(): OpenAIAdsConfig {
  return validateConfig({
    apiKey: (process.env.OPENAI_ADS_API_KEY ?? "").trim(),
    accountId: (process.env.OPENAI_ADS_ACCOUNT_ID ?? "").trim(),
    enableWrites: flag("OPENAI_ADS_ENABLE_WRITES"),
    enableActivation: flag("OPENAI_ADS_ENABLE_ACTIVATION"),
  });
}
