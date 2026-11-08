/**
 * chatgpt-ads-mcp-server: an open-source MCP server for the ChatGPT Ads Advertiser API.
 * Copyright 2026 GetMCPAds. https://www.getmcpads.com
 * SPDX-License-Identifier: Apache-2.0
 *
 * Bulk API contract. It is documented on developers.openai.com/ads/bulk-api, in
 * limited preview, enabled per ad account and absent from the downloadable
 * OpenAPI document. Bulk inputs are deliberately independent from the
 * single-resource request bodies.
 */
import { z } from "zod";

const text = z.string().min(3).max(1000).regex(/\S/), key = z.string().min(1).max(255).regex(/\S/), money = z.number().int().safe().min(1);
const status = z.enum(["active", "paused", "archived"]);
const common = { operation_id: key, type: z.string() };
const campaignCreate = z.object({ name: text, max_budget_micros: money.min(1000000), billing_event_type: z.enum(["impression", "click"]).optional(), budget_type: z.enum(["daily", "lifetime"]).optional(), status: z.enum(["active", "paused"]).prefault("paused"), target_countries: z.array(z.string().regex(/^[A-Z]{2}$/)).optional(), location_ids: z.array(z.string().min(1)).max(2500).optional() }).strict();
const campaignUpdate = z.object({ name: text.optional(), description: z.string().optional(), status: status.optional(), max_budget_micros: money.min(1000000).optional(), budget_type: z.enum(["daily", "lifetime"]).optional(), start_time: z.number().int().safe().optional(), end_time: z.number().int().safe().optional(), location_ids: z.array(z.string().min(1)).max(2500).optional() }).strict().refine(v => Object.keys(v).length > 0, "An update needs at least one field.");
const groupFields = { context_hints: z.array(z.string()).max(2000).optional(), exclusion_hints: z.array(z.string()).max(2000).optional(), max_bid_micros: money.optional(), max_cpm_bid_micros: money.optional() };
const groupCreate = z.object({ campaign_idempotency_key: key, name: text, ...groupFields, status: z.enum(["active", "paused"]).prefault("paused") }).strict().refine(v => !(v.max_bid_micros && v.max_cpm_bid_micros), "Choose only one bid field.");
const groupUpdate = z.object({ name: text.optional(), description: z.string().optional(), status: status.optional(), ...groupFields }).strict().refine(v => Object.keys(v).length > 0 && !(v.max_bid_micros && v.max_cpm_bid_micros), "Use at least one update field and only one bid field.");
const creative = { title: z.string().min(3).max(50).regex(/\S/), body: z.string().max(100), target_url: z.string().url().startsWith("https://").max(2048) };
const adCreate = z.object({ campaign_idempotency_key: key, ad_group_idempotency_key: key, ...creative, source_image_url: z.string().url().startsWith("https://").max(2048), status: z.enum(["active", "paused"]).prefault("paused") }).strict();
const adUpdate = z.object({ name: text.optional(), status: status.optional(), creative: z.object({ ...creative, file_id: z.string().min(1) }).strict().optional() }).strict().refine(v => Object.keys(v).length > 0, "An update needs at least one field.");

export const adsBulkBody = z.object({
  validate_only: z.boolean().prefault(true),
  partial_failure: z.boolean().prefault(true),
  operations: z.array(z.discriminatedUnion("type", [
    z.object({ ...common, type: z.literal("campaign.create"), idempotency_key: key, input: campaignCreate }).strict(),
    z.object({ ...common, type: z.literal("campaign.update"), target_resource_id: z.string().regex(/^cmpn_[A-Za-z0-9_-]{1,128}$/), input: campaignUpdate }).strict(),
    z.object({ ...common, type: z.literal("ad_group.create"), idempotency_key: key, input: groupCreate }).strict(),
    z.object({ ...common, type: z.literal("ad_group.update"), target_resource_id: z.string().regex(/^adgrp_[A-Za-z0-9_-]{1,128}$/), input: groupUpdate }).strict(),
    z.object({ ...common, type: z.literal("ad.create"), idempotency_key: key, input: adCreate }).strict(),
    z.object({ ...common, type: z.literal("ad.update"), target_resource_id: z.string().regex(/^ad_[A-Za-z0-9_-]{1,128}$/), input: adUpdate }).strict(),
  ])).min(1).max(1000),
}).strict().superRefine((body, ctx) => {
  const ids = new Set<string>(), creates = new Map<string, (typeof body.operations)[number]>(), updates = new Set<string>();
  for (const op of body.operations) {
    if (ids.has(op.operation_id)) ctx.addIssue({ code: "custom", message: "operation_id must be unique." });
    ids.add(op.operation_id);
    if ("idempotency_key" in op) { if (creates.has(op.idempotency_key)) ctx.addIssue({ code: "custom", message: "Create keys must be unique." }); creates.set(op.idempotency_key, op); }
    if ("target_resource_id" in op) { if (updates.has(op.target_resource_id)) ctx.addIssue({ code: "custom", message: "Update each resource once per job." }); updates.add(op.target_resource_id); }
  }
  for (const op of body.operations) {
    if (op.type === "ad_group.create" || op.type === "ad.create") {
      const campaign = creates.get(op.input.campaign_idempotency_key);
      if (campaign?.type !== "campaign.create") ctx.addIssue({ code: "custom", message: "The campaign parent must be created in this same job." });
      if (op.type === "ad_group.create" && campaign?.type === "campaign.create") {
        const click = campaign.input.billing_event_type === "click";
        if (click && op.input.max_cpm_bid_micros || !click && op.input.max_bid_micros) ctx.addIssue({ code: "custom", message: "The group bid field must match its parent billing event." });
      }
      if (op.type === "ad.create") {
        const group = creates.get(op.input.ad_group_idempotency_key);
        if (group?.type !== "ad_group.create" || group.input.campaign_idempotency_key !== op.input.campaign_idempotency_key) ctx.addIssue({ code: "custom", message: "The ad and group must reference the same campaign in this job." });
      }
    }
  }
  if (new TextEncoder().encode(JSON.stringify(body)).byteLength > 16 * 1024 * 1024) ctx.addIssue({ code: "custom", message: "Bulk body exceeds 16 MiB." });
});
export const adsBulkJobId = z.string().regex(/^blkmtnjob_[A-Za-z0-9_-]{1,128}$/).describe("Native bulk job ID, blkmtnjob_ followed by its identifier, returned when the job was submitted.");
export const adsBulkResultsQuery = z.object({ limit: z.number().int().min(1).max(100).prefault(100), after: key.optional() }).strict().prefault({}).describe("Page size from 1 to 100 and, for later pages, the last operation_id of the previous page as after.");
export type AdsBulkBody = z.infer<typeof adsBulkBody>;
