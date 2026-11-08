#!/usr/bin/env node
/**
 * Pins the account-scoped operations from a locally saved copy of the official
 * OpenAPI document (https://developers.openai.com/ads/openapi.json). It reads a
 * file and writes src/openai-ads-contracts.json. It never uses the network or a key.
 *
 *   node scripts/generate-contracts.mjs path/to/openapi.json 2026-10-14
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const [source, retrievedAt] = process.argv.slice(2);
if (!source || !/^\d{4}-\d{2}-\d{2}$/.test(retrievedAt ?? "")) { console.error("Usage: node scripts/generate-contracts.mjs <openapi.json> <YYYY-MM-DD>"); process.exit(1); }
const raw = readFileSync(source), spec = JSON.parse(raw.toString("utf8"));
const names = new Map();
for (const [plural, singular, param] of [["campaigns", "campaign", "campaign_id"], ["ad_groups", "ad_group", "ad_group_id"], ["ads", "ad", "ad_id"]]) {
  names.set(`post /${plural}`, `create_${singular}`);
  names.set(`post /${plural}/{${param}}`, `update_${singular}`);
  for (const verb of ["pause", "activate", "archive"]) names.set(`post /${plural}/{${param}}/${verb}`, `${verb}_${singular}`);
}
names.set("post /ads/{ad_id}/preview", "create_ad_preview");
// Key provisioning, partner ownership, audience membership uploads and financial or
// account administration deliberately stay outside this server.
for (const [key, name] of Object.entries({
  "get /geo_lookup/search": "search_locations", "get /audit_logs": "get_audit_logs", "get /ad_account/spend_limit_windows": "get_spend_limits",
  "get /ads/{ad_id}/landing_page_crawl": "get_landing_page_crawl", "get /conversions/event_settings": "get_conversion_settings",
  "get /conversions/pixels": "get_conversion_pixels", "get /conversions/events": "get_conversion_events", "post /conversions/insights": "get_conversion_insights",
  "post /conversions/event_settings": "create_conversion_setting", "post /conversions/pixels": "create_conversion_pixel",
  "get /feeds": "get_feeds", "post /feeds": "create_feed", "get /feeds/uploads": "get_feed_uploads", "get /feeds/{feed_id}/settings": "get_feed_settings",
  "patch /feeds/{feed_id}/settings": "update_feed_settings", "post /feeds/{feed_id}/products/query": "get_feed_products",
  "patch /feeds/{feed_id}/products": "update_feed_products", "post /feeds/{feed_id}/archive": "archive_feed",
  "get /custom_audiences": "get_custom_audiences", "get /custom_audiences/{custom_audience_id}": "get_custom_audience",
  "get /custom_audiences/{custom_audience_id}/operations": "get_audience_operations",
  "get /custom_audiences/{custom_audience_id}/operations/{operation_id}": "get_audience_operation",
})) names.set(key, name);

const used = new Set();
const refs = value => {
  if (Array.isArray(value)) return value.forEach(refs);
  if (!value || typeof value !== "object") return;
  if (value.$ref) { const name = value.$ref.split("/").pop(); if (!used.has(name)) { used.add(name); refs(spec.components.schemas[name]); } }
  Object.values(value).forEach(refs);
};
const operations = [];
for (const [key, name] of names) {
  const [method, path] = key.split(" "), op = spec.paths[path]?.[method];
  if (!op) throw new Error(`The OpenAPI document no longer has ${key}.`);
  const body = op.requestBody?.content?.["application/json"]?.schema ?? null;
  const parameters = (op.parameters ?? []).filter(p => p.in === "path" || p.in === "query");
  refs(body); refs(parameters);
  operations.push({ name: `openai_ads_${name}`, method: method.toUpperCase(), path, write: !/^(get_|search_)/.test(name), parameters, body, idempotentCreate: (op.parameters ?? []).some(p => p.name === "Idempotency-Key") });
}
for (const name of ["UploadImageBody", "UploadImageResource"]) { used.add(name); refs(spec.components.schemas[name]); }
const out = { source: "https://developers.openai.com/ads/openapi.json", sha256: createHash("sha256").update(raw).digest("hex"), retrievedAt, operations, definitions: Object.fromEntries([...used].sort().map(k => [k, spec.components.schemas[k]])) };
writeFileSync(new URL("../src/openai-ads-contracts.json", import.meta.url), JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify({ operations: operations.length, definitions: used.size, sha256: out.sha256 }));
