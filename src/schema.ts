/**
 * chatgpt-ads-mcp-server: an open-source MCP server for the ChatGPT Ads Advertiser API.
 * Copyright 2026 GetMCPAds. https://www.getmcpads.com
 * SPDX-License-Identifier: Apache-2.0
 */
import { z } from "zod";
import contracts from "./openai-ads-contracts.json";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type AdsParameter = { name: string; in: string; required?: boolean; description?: string; schema: any };
export type AdsOperation = { name: string; method: string; path: string; write: boolean; parameters: readonly AdsParameter[]; body: any; idempotentCreate: boolean };

/** Operations pinned from the public OpenAPI document; see SOURCE_SYNC.md for its revision. */
export const OPENAI_ADS_CONTRACT_SOURCE = { source: contracts.source, sha256: contracts.sha256, retrievedAt: contracts.retrievedAt };
export const OPENAI_ADS_OPERATIONS: readonly AdsOperation[] = contracts.operations as unknown as AdsOperation[];
export const OPENAI_ADS_DEFINITIONS: Record<string, any> = contracts.definitions;

/** Convert only the pinned JSON Schema vocabulary. Unsupported contracts fail closed. */
export function adsSchema(s: any, depth = 0): z.ZodTypeAny {
  if (depth > 30) throw new Error("ChatGPT Ads schema recursion limit.");
  if (!s) return z.object({}).strict();
  if (s.$ref) {
    const name = String(s.$ref).replace("#/components/schemas/", "");
    const definition = OPENAI_ADS_DEFINITIONS[name];
    if (!definition) throw new Error("Unknown pinned ChatGPT Ads definition.");
    return adsSchema(definition, depth + 1);
  }
  let result: z.ZodTypeAny;
  if (s.anyOf || s.oneOf) {
    const alternatives = (s.anyOf ?? s.oneOf).map((v: any) => adsSchema(v, depth + 1));
    result = alternatives.length === 1 ? alternatives[0] : z.union(alternatives as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  } else if (s.enum) result = s.enum.length === 1 ? z.literal(s.enum[0]) : z.union(s.enum.map((v: string | number | boolean | null) => z.literal(v)) as [any, any, ...any[]]);
  else if (s.type === "null") result = z.null();
  else if (s.type === "boolean") result = z.boolean();
  else if (s.type === "integer" || s.type === "number") {
    let n = z.number().finite();
    if (s.type === "integer") n = n.int().safe();
    if (s.minimum !== undefined) n = n.min(s.minimum);
    if (s.maximum !== undefined) n = n.max(s.maximum);
    result = n;
  } else if (s.type === "string") {
    let str = z.string();
    if (s.minLength !== undefined) str = str.min(s.minLength);
    if (s.maxLength !== undefined) str = str.max(s.maxLength);
    if (s.pattern) str = str.regex(new RegExp(s.pattern));
    if (s.format === "date-time") str = str.datetime({ offset: true });
    if (s.format === "uri") str = str.url();
    result = str;
  } else if (s.type === "array") {
    let array = z.array(adsSchema(s.items, depth + 1));
    if (s.minItems !== undefined) array = array.min(s.minItems);
    if (s.maxItems !== undefined) array = array.max(s.maxItems);
    result = array;
  } else if (s.type === "object" || s.properties) {
    const fields: Record<string, z.ZodTypeAny> = {};
    for (const [key, value] of Object.entries(s.properties ?? {})) {
      const field = adsSchema(value, depth + 1);
      fields[key] = s.required?.includes(key) ? field : field.optional();
    }
    result = s.additionalProperties && typeof s.additionalProperties === "object"
      ? z.object(fields).catchall(adsSchema(s.additionalProperties, depth + 1)) : z.object(fields).strict();
  } else throw new Error("Unsupported pinned ChatGPT Ads schema vocabulary.");
  return s.description ? result.describe(s.description) : result;
}

export function adsOperation(name: string): AdsOperation {
  const op = OPENAI_ADS_OPERATIONS.find(o => o.name === name);
  if (!op) throw new Error("Unknown ChatGPT Ads operation.");
  return op;
}

export function adsOperationShape(op: AdsOperation): Record<string, z.ZodTypeAny> {
  const path = Object.fromEntries(op.parameters.filter(p => p.in === "path").map(p => [p.name, adsSchema(p.schema).refine(v => typeof v === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(v), "Use the exact native identifier.").describe(`Exact native ${p.name}. The entity must belong to the configured ad account.`)]));
  const query = Object.fromEntries(op.parameters.filter(p => p.in === "query").map(p => [p.name, p.required ? adsSchema(p.schema) : adsSchema(p.schema).optional()]));
  return {
    ...path,
    ...(Object.keys(query).length ? { query: z.object(query).strict().default({}).describe("Documented native query parameters. Each call reads one page unless the tool says otherwise.") } : {}),
    ...(op.body ? { body: adsSchema(op.body).describe("Exact pinned native JSON request body. Nested configuration objects replace their previous contents, so send the complete intended configuration. Money uses integer account-currency micros.") } : {}),
  };
}

export const adsCanonical = (v: any): any => Array.isArray(v) ? v.map(adsCanonical) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => [k, adsCanonical(v[k])])) : v;

export async function adsHash(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(adsCanonical(value))));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}
