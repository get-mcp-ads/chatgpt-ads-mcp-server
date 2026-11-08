/**
 * chatgpt-ads-mcp-server: an open-source MCP server for the ChatGPT Ads Advertiser API.
 * Copyright 2026 GetMCPAds. https://www.getmcpads.com
 * SPDX-License-Identifier: Apache-2.0
 */

/** The only host this server sends requests to. The API key is never sent anywhere else. */
export const OPENAI_ADS_API_BASE = "https://api.ads.openai.com/v1";
export const REQUEST_TIMEOUT_MS = 30_000;
/** Upper bound for one provider response body. Larger bodies are refused, never truncated. */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export class ResponseTooLargeError extends Error {
  constructor() { super("Response exceeded the size bound."); this.name = "ResponseTooLargeError"; }
}

/** Reads a response body as text and stops once it exceeds the byte bound. */
export async function readBounded(response: Response, maxBytes = MAX_RESPONSE_BYTES): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ResponseTooLargeError();
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "", bytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ResponseTooLargeError();
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}

/** True when the response is a redirect. Its Location is never read or followed. */
export function isRedirect(response: Response): boolean {
  return response.status >= 300 && response.status < 400;
}

const PRIVATE_HOST = [
  /^localhost$/, /\.localhost$/, /\.local$/, /\.internal$/, /^metadata\.google\.internal$/,
  /^0\./, /^127\./, /^10\./, /^192\.168\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

/**
 * A URL supplied for the provider to fetch is data. Require public HTTPS without
 * credentials or a fragment, and refuse loopback, private, link-local and
 * metadata addresses, including every bracketed IPv6 literal and bare numeric hosts.
 */
export function isPublicHttpsUrl(raw: string, maxLength = 4000): boolean {
  if (typeof raw !== "string" || raw.length > maxLength) return false;
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host.startsWith("[") || !host.includes(".")) return false;
  if (/^\d+$/.test(host) || /^0x/i.test(host)) return false;
  return !PRIVATE_HOST.some(pattern => pattern.test(host));
}
