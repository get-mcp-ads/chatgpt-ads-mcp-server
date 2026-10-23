/**
 * chatgpt-ads-mcp-server: an open-source MCP server for the ChatGPT Ads Advertiser API.
 * Copyright 2026 GetMCPAds. https://www.getmcpads.com
 * SPDX-License-Identifier: Apache-2.0
 */
import { z } from "zod";
import { OpenAIAdsError, redact } from "./client.js";

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
export const ok = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

/** Maps any failure to a structured, non-retryable MCP error. Never includes the API key. */
export function toolError(error: unknown, write: boolean, secret: string): ToolResult {
  const occurredAtUtc = new Date().toISOString();
  if (error instanceof z.ZodError) {
    return { ...ok({ error: { code: "INVALID_INPUT", message: "The arguments do not match the tool schema. Nothing was sent.", fields: error.issues.map(i => ({ path: i.path.join("."), code: i.code, message: redact(i.message, secret).slice(0, 300) })), retryable: false, recoverable: true }, ...(write ? { applied: false, outcome: "rejected" } : {}) }), isError: true };
  }
  if (error instanceof OpenAIAdsError) {
    const inputError = error.status === 400 || error.status === 409 || error.status === 422;
    return {
      ...ok({
        error: {
          code: error.code, message: error.message, status: error.status,
          ...(error.nativeMessage ? { nativeMessage: error.nativeMessage } : {}),
          ...(error.details ? { nativeConstraint: error.details } : {}),
          requestId: error.requestId ?? null, occurredAtUtc, retryable: false, recoverable: inputError, human_action_required: !inputError,
          next_action: inputError ? "Correct the arguments using the tool schema and the error message. No request was retried." : "Stop automated retries. Check the configuration, or contact OpenAI Ads support with this request reference.",
        },
        ...(write ? { applied: false, outcome: error.status >= 400 && error.status < 500 ? "rejected" : "unknown" } : {}),
      }),
      isError: true,
    };
  }
  const message = error instanceof Error ? redact(error.message, secret).slice(0, 300) : "Unexpected failure.";
  return { ...ok({ error: { code: "INTERNAL_ERROR", message, occurredAtUtc, retryable: false }, ...(write ? { applied: false, outcome: "unknown" } : {}) }), isError: true };
}
