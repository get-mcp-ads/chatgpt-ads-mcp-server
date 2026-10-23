/**
 * chatgpt-ads-mcp-server: an open-source MCP server for the ChatGPT Ads Advertiser API.
 * Copyright 2026 GetMCPAds. https://www.getmcpads.com
 * SPDX-License-Identifier: Apache-2.0
 */
import { z } from "zod";
import { OpenAIAdsClient, OpenAIAdsError, type EntityKind } from "./client.js";
import { OPENAI_ADS_CONTRACT_SOURCE, OPENAI_ADS_DEFINITIONS, OPENAI_ADS_OPERATIONS, adsHash, adsOperationShape, type AdsOperation } from "./schema.js";
import { adsBulkBody, adsBulkJobId, adsBulkResultsQuery } from "./bulk.js";
import { imageDimensions } from "./media-dimensions.js";
import { OPERATION_SUMMARIES } from "./descriptions.js";
import { ok, toolError } from "./tool-errors.js";
import type { ToolShape } from "./tool-quality.js";
import { accountParam as account, type Collector, type ToolContext } from "./context.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
const approval = {
  requestId: z.string().uuid().describe("A UUID you choose for this exact logical change. Keep it for the preview, the confirmation and any later reconciliation. Creations send it as the native Idempotency-Key."),
  confirm: z.boolean().default(false).describe("false returns a saved preview and changes nothing. true applies only that exact preview after the person explicitly approved it."),
  confirmationToken: z.string().uuid().optional().describe("The confirmationToken returned by the preview of these exact arguments. Required with confirm:true."),
};
const WRITE_NOTE = "Previews by default: call without confirm to receive a saved preview and confirmationToken, then repeat the identical call with confirm:true and that token once the person approves. Creations are always paused. Budgets and bids use integer account-currency micros. Nothing is retried automatically. See openai_ads_get_write_schema for nested fields.";
const READ_NOTE = "Native fields and pagination are preserved. See openai_ads_get_write_schema for nested request fields.";

function entity(op: AdsOperation, args: Record<string, any>): { kind: EntityKind; id: string } | null {
  const match = op.path.match(/^\/(campaigns|ad_groups|ads)\/(?:\{[^}]+\})/);
  if (!match) return null;
  const kind = match[1] as EntityKind;
  return { kind, id: String(args[{ campaigns: "campaign_id", ad_groups: "ad_group_id", ads: "ad_id" }[kind]]) };
}

/** Review jobs and expiring image URLs change without an advertiser edit. Approval binds to every
 * editable field, with the immutable file ID as the image identity. */
export function adsEditableSnapshot(value: Record<string, any>) {
  const fields = ["id", "name", "status", "description", "start_time", "end_time", "budget", "bidding_type", "objective", "billing_event_type", "mode", "product_feed_id", "business_agent_id", "targeting", "landing_page_configuration", "conversion_event_setting_ids", "context_hints", "bidding_config", "product_set", "creative"];
  const state: Record<string, any> = Object.fromEntries(fields.filter(k => Object.hasOwn(value, k)).map(k => [k, value[k]]));
  if (state.creative && typeof state.creative === "object") {
    state.creative = { ...state.creative };
    if (typeof state.creative.file_id === "string") delete state.creative.image_url;
  }
  return state;
}

type FeedVariantChange = { id: string; title?: string; price?: { amount: number; currency: string }; availability?: { available?: boolean; status?: string } };
type FeedTarget = { productId: string; change: FeedVariantChange };
function feedTargets(args: Record<string, any>): FeedTarget[] {
  const targets = (args.body.products as { id: string; variants: FeedVariantChange[] }[]).flatMap(p => p.variants.map(change => ({ productId: p.id, change })));
  if (targets.length > 500 || new Set(targets.map(t => t.change.id)).size !== targets.length) throw new OpenAIAdsError(400, "INVALID_PRODUCT_SELECTION", "Update at most 500 distinct variants in one approved request.");
  if (targets.some(t => t.change.title === undefined && !t.change.price && !Object.keys(t.change.availability ?? {}).length)) throw new OpenAIAdsError(400, "EMPTY_PRODUCT_UPDATE", "Each variant needs a title, price or availability change.");
  return targets;
}
const unverifiableProducts = (): never => { throw new OpenAIAdsError(409, "PRODUCT_STATE_UNVERIFIABLE", "The exact product and variant identities or requested fields could not be read completely. No product update can be approved from this response."); };
const FEED_PRICE = /^(\d+)(?:\.(\d+))? ([A-Z]{3})$/;
/** Product queries return major-unit price strings; Delta writes use minor units, never campaign micros. */
function feedPrice(value: unknown): { amount: number; currency: string } | null {
  if (value === null) return null;
  if (typeof value !== "string") return unverifiableProducts();
  const match = value.match(FEED_PRICE);
  if (!match) return unverifiableProducts();
  const decimals = new Intl.NumberFormat("en", { style: "currency", currency: match[3] }).resolvedOptions().maximumFractionDigits ?? 2;
  const fraction = match[2] ?? "";
  if (fraction.slice(decimals).replaceAll("0", "")) return unverifiableProducts();
  const amount = Number(BigInt(match[1] + fraction.slice(0, decimals).padEnd(decimals, "0")));
  if (!Number.isSafeInteger(amount)) return unverifiableProducts();
  return { amount, currency: match[3] };
}
function feedVariantState(row: Record<string, unknown>, change: FeedVariantChange) {
  const state: Record<string, unknown> = {};
  if (change.title !== undefined) { if (typeof row.title !== "string" && row.title !== null) return unverifiableProducts(); state.title = row.title; }
  if (change.price) state.price = feedPrice(row.price);
  if (change.availability) {
    if (typeof row.availability !== "string" && row.availability !== null) return unverifiableProducts();
    const availability: Record<string, unknown> = {};
    if (change.availability.status !== undefined) availability.status = row.availability;
    if (change.availability.available !== undefined) {
      if (row.availability !== null && !["in_stock", "out_of_stock"].includes(row.availability as string)) return unverifiableProducts();
      availability.available = row.availability === null ? null : row.availability === "in_stock";
    }
    state.availability = availability;
  }
  return state;
}
async function feedProductSnapshot(client: OpenAIAdsClient, id: string, args: Record<string, any>) {
  const targets = feedTargets(args);
  const response = await client.native(id, "openai_ads_get_feed_products", { feed_id: args.feed_id, body: { filters: [{ field: "item_id", operator: "in", values: targets.map(t => t.change.id) }], limit: targets.length } });
  if (!Array.isArray(response.data) || response.has_more !== false || response.data.length !== targets.length) return unverifiableProducts();
  const rows = new Map<string, Record<string, unknown>>();
  for (const row of response.data) {
    if (!row || typeof row !== "object" || Array.isArray(row) || typeof row.item_id !== "string" || rows.has(row.item_id)) return unverifiableProducts();
    rows.set(row.item_id, row);
  }
  return {
    feedId: args.feed_id, products: targets.map(({ productId, change }) => {
      const row = rows.get(change.id);
      if (!row || row.product_id !== productId) return unverifiableProducts();
      return { productId, variantId: change.id, ...feedVariantState(row, change) };
    }),
  };
}

async function accountSnapshot(client: OpenAIAdsClient, id: string) {
  const a = await client.account(id);
  return { id: a.id, currency: a.currency_code, timezone: a.timezone, status: a.status };
}

/** The native state an approval binds to. A confirmation re-reads it and refuses any difference. */
async function capture(client: OpenAIAdsClient, id: string, op: AdsOperation, args: Record<string, any>) {
  if (op.name === "openai_ads_update_feed_products") return feedProductSnapshot(client, id, args);
  const target = entity(op, args);
  if (target) return adsEditableSnapshot(await client.entity(id, target.kind, target.id));
  if (op.name === "openai_ads_create_ad_group") {
    const parent = await client.entity(id, "campaigns", args.body.campaign_id);
    const bidding = args.body.bidding_config, kind = parent.bidding_type;
    if (kind && bidding.billing_event_type !== (kind === "impressions" ? "impression" : "click")) throw new OpenAIAdsError(400, "INCOMPATIBLE_BILLING", "The ad group billing event must match its campaign objective.");
    const strategy = bidding.strategy ?? (bidding.max_bid_micros ? "fixed_bid" : kind === "clicks" ? "maximize_clicks" : kind === "conversions" ? "maximize_conversions" : null);
    if (!strategy || strategy === "maximize_clicks" && kind !== "clicks" || strategy === "maximize_conversions" && kind !== "conversions") throw new OpenAIAdsError(400, "INCOMPATIBLE_BIDDING", "Choose a bid strategy compatible with the parent campaign.");
    if (strategy.startsWith("maximize_") && !(parent.budget as any)?.daily_spend_limit_micros) throw new OpenAIAdsError(400, "AUTOBID_DAILY_BUDGET_REQUIRED", "Maximize Results requires a daily campaign budget.");
    if (args.body.product_set?.product_feed_id !== undefined && args.body.product_set.product_feed_id !== parent.product_feed_id) throw new OpenAIAdsError(400, "PRODUCT_FEED_MISMATCH", "The ad group product set must use its campaign's feed.");
    return adsEditableSnapshot(parent);
  }
  if (op.name === "openai_ads_create_ad") {
    const parent = await client.entity(id, "ad_groups", args.body.ad_group_id);
    if (args.body.creative.type === "product_ad_template") {
      const existing = await client.list(id, "ads", { parentId: args.body.ad_group_id });
      if (existing.data.some(ad => ad.status !== "archived" && (ad.creative as any)?.type === "product_ad_template")) throw new OpenAIAdsError(400, "PRODUCT_TEMPLATE_EXISTS", "A product ad group can contain only one non-archived product template.");
    }
    return adsEditableSnapshot(parent);
  }
  if (args.feed_id) return client.native(id, "openai_ads_get_feed_settings", { feed_id: args.feed_id });
  return accountSnapshot(client, id);
}

function contains(actual: any, expected: any): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((v, i) => contains(actual[i], v));
  if (expected && typeof expected === "object") return actual && typeof actual === "object" && Object.entries(expected).every(([k, v]) => contains(actual[k], v));
  return actual === expected;
}

/** Native readback after an acknowledged write. It never submits anything. */
async function verification(client: OpenAIAdsClient, id: string, op: AdsOperation, args: Record<string, any>, result: any) {
  if (op.name === "openai_ads_update_feed_products") {
    const current = await feedProductSnapshot(client, id, args);
    const expected = feedTargets(args).map(({ productId, change: { id: variantId, ...change } }) => ({ productId, variantId, ...change }));
    return { confirmed: contains(current.products, expected), mode: "native_product_readback", current };
  }
  let target = entity(op, args);
  if (op.idempotentCreate) target = { kind: op.path.slice(1) as EntityKind, id: result.id };
  if (!target) return { confirmed: null, mode: "provider_receipt" };
  const current = await client.entity(id, target.kind, target.id);
  const expected = { ...(args.body ?? {}) };
  delete expected.campaign_id; delete expected.ad_group_id;
  // Some read models omit the file ID. Compare it whenever it is returned; an expiring image URL never stands in for it.
  if (expected.creative) { expected.creative = { ...expected.creative }; if (typeof (current.creative as Record<string, unknown> | undefined)?.file_id !== "string") delete expected.creative.file_id; }
  if (op.path.endsWith("/pause")) expected.status = "paused";
  if (op.path.endsWith("/activate")) expected.status = "active";
  if (op.path.endsWith("/archive")) expected.status = "archived";
  let parentMembershipConfirmed: boolean | null = null;
  if (op.name === "openai_ads_create_ad_group") parentMembershipConfirmed = (await client.list(id, "ad_groups", { parentId: args.body.campaign_id })).data.some(o => o.id === target!.id);
  if (op.name === "openai_ads_create_ad") parentMembershipConfirmed = (await client.list(id, "ads", { parentId: args.body.ad_group_id })).data.some(o => o.id === target!.id);
  return { confirmed: current.id === target.id && contains(current, expected) && parentMembershipConfirmed !== false, mode: "native_readback", current, parentMembershipConfirmed, ...(parentMembershipConfirmed === false ? { reason: "The provider acknowledged creation but its parent inventory does not list the entity yet. Keep the returned ID and confirm again later to reconcile; do not create a replacement." } : {}) };
}

const maySpend = (op: AdsOperation, args: Record<string, any>) => op.path.endsWith("/activate") || args.body?.status === "active";

export function registerOpenAINative(c: Collector, ctx: ToolContext, write: boolean): void {
  const { client, mutations } = ctx;
  const handle = (fn: (raw: Record<string, unknown>) => Promise<unknown>) => async (raw: Record<string, unknown>) => {
    try { return ok(await fn(raw)); } catch (error) { return toolError(error, write, ctx.secret); }
  };

  for (const op of OPENAI_ADS_OPERATIONS.filter(o => o.write === write)) {
    const nativeShape = adsOperationShape(op);
    if (op.name === "openai_ads_update_feed_products") nativeShape.body = nativeShape.body.describe("Delta changes to existing products and variants. price.amount uses integer minor currency units (7999 = USD 79.99), never campaign micros. At most 500 distinct variants; their exact product_id, item_id and requested fields must be readable before approval.");
    const shape: ToolShape = { adAccountId: account, ...nativeShape, ...(write ? approval : {}) };
    const summary = OPERATION_SUMMARIES[op.name] ?? `Native ChatGPT Ads ${op.name.replace("openai_ads_", "").replaceAll("_", " ")} operation.`;
    c.tool(op.name, `${summary} ${write ? WRITE_NOTE : READ_NOTE}`, shape, handle(async raw => {
      const args = z.object(shape).strict().parse(raw) as Record<string, any>;
      const { adAccountId, requestId, confirm, confirmationToken, ...native } = args;
      if (!write) return client.native(adAccountId, op.name, native);
      client.validateMutation(adAccountId, op, native);
      return mutations.run(adAccountId, op.name, requestId, native, confirm, confirmationToken,
        () => capture(client, adAccountId, op, native), () => client.native(adAccountId, op.name, native, requestId), r => verification(client, adAccountId, op, native, r),
        { activationMaySpend: maySpend(op, native) });
    }));
  }

  if (!write) {
    const jobShape = { adAccountId: account, jobId: adsBulkJobId };
    c.tool("openai_ads_get_bulk_job", "Read one Bulk API job (limited preview, enabled per account). Only completed, partially_failed and failed are terminal. A completed job still requires reading every operation result and the native entities.", jobShape, handle(async raw => {
      const a = z.object(jobShape).strict().parse(raw);
      return client.bulkJob(a.adAccountId, a.jobId);
    }));
    const resultsShape = { adAccountId: account, jobId: adsBulkJobId, query: adsBulkResultsQuery };
    c.tool("openai_ads_get_bulk_job_operations", "Read one page of Bulk API operation outcomes: created, updated, validated, failed or skipped. Pass the last operation_id as after only when has_more is true. A partial failure never rolls back earlier operations; do not resubmit an uncertain job.", resultsShape, handle(async raw => {
      const a = z.object(resultsShape).strict().parse(raw);
      return client.bulkResults(a.adAccountId, a.jobId, a.query);
    }));
    const schemaShape = { adAccountId: account, toolName: z.string().startsWith("openai_ads_").optional().describe("Optional tool name, such as openai_ads_create_campaign, to return only that operation. Omit for all.") };
    c.tool("openai_ads_get_write_schema", "Read the pinned native request definitions, paths and parameters of every operation, the upload and bulk limits, and what this server leaves out. Schema support does not imply that the account is eligible for a feature.", schemaShape, handle(async raw => {
      const a = z.object(schemaShape).strict().parse(raw);
      client.scope(a.adAccountId);
      const ops = OPENAI_ADS_OPERATIONS.filter(o => !a.toolName || o.name === a.toolName);
      return {
        operations: ops, definitions: OPENAI_ADS_DEFINITIONS,
        uploads: { binaryTool: "openai_ads_upload_image", urlTool: "openai_ads_upload_image_url", types: ["PNG", "JPEG", "WebP"], minimumDimensions: "640 x 640", maxBytes: 5242880 },
        campaigns: { objectives: ["impressions", "clicks", "conversions"], modes: ["standard", "product_feed", "business_agent"], strategies: ["fixed_bid", "maximize_clicks", "maximize_conversions"], budgets: ["daily", "lifetime"], creativeTypes: ["chat_card", "product_ad_template"], businessAgentPrerequisite: "An existing native business_agent_id; no provisioning endpoint is documented." },
        bulk: { submit: "openai_ads_submit_bulk_job", status: "openai_ads_get_bulk_job", results: "openai_ads_get_bulk_job_operations", source: "https://developers.openai.com/ads/bulk-api", availability: "Limited preview, enabled per account; absent from the downloadable OpenAPI document.", input: "Independent documented schema. Do not substitute single-resource bodies.", types: ["campaign.create", "campaign.update", "ad_group.create", "ad_group.update", "ad.create", "ad.update"], maxOperations: 1000, maxBytes: 16777216 },
        exclusions: ["API key provisioning", "Billing, spend limit changes and account administration", "Partner account creation and ownership", "Custom audience creation and membership uploads", "Lead-sync webhooks", "SFTP credential provisioning"],
        source: OPENAI_ADS_CONTRACT_SOURCE, nativeEligibilityRequired: true,
      };
    }));
    const contextShape = { adAccountId: account };
    c.tool("openai_ads_get_write_context", "Read the account, its conversion settings and its product feeds before proposing a campaign. Lists the native objective, billing and bid strategy combinations and the missing prerequisites. It grants no eligibility and creates nothing.", contextShape, handle(async raw => {
      const a = z.object(contextShape).strict().parse(raw);
      const advertiser = await client.account(a.adAccountId);
      const goals = await client.native(a.adAccountId, "openai_ads_get_conversion_settings", { query: { limit: 500 } });
      const feeds = await client.native(a.adAccountId, "openai_ads_get_feeds", { query: { limit: 500, include: ["product_count"] } });
      return {
        account: advertiser, conversionSettings: goals, feeds,
        combinations: [{ objective: "impressions", billing: "impression", strategy: "fixed_bid", budgets: ["daily", "lifetime"] }, { objective: "clicks", billing: "click", strategy: "fixed_bid", budgets: ["daily", "lifetime"] }, { objective: "clicks", billing: "click", strategy: "maximize_clicks", budgets: ["daily"] }, { objective: "conversions", billing: "click", strategy: "fixed_bid", budgets: ["daily", "lifetime"] }, { objective: "conversions", billing: "click", strategy: "maximize_conversions", budgets: ["daily"] }],
        requirements: { conversions: "Exactly one active standard conversion setting owned by this account.", productFeed: "An owned, ingested feed with matching eligible products. One product_ad_template per ad group.", businessAgent: "An existing account-owned business_agent_id. The documented API has no provisioning or listing endpoint for it." },
        eligibility: "Native validation is authoritative. An empty inventory is a missing prerequisite, not a successful creation.",
      };
    }));
    const mutationShape = { adAccountId: account, mutationId: z.string().uuid().describe("The confirmationToken or mutationId returned by a write preview or receipt.") };
    c.tool("openai_ads_get_mutation", "Read a write preview or receipt held by this server process: its state, the native state it was approved against and the result. Receipts live in memory and a restart forgets them. Never resubmit a write whose state is UNKNOWN or APPLYING.", mutationShape, handle(async raw => {
      const a = z.object(mutationShape).strict().parse(raw);
      return mutations.status(a.adAccountId, a.mutationId);
    }));
    return;
  }

  const bulkShape = { adAccountId: account, body: adsBulkBody.describe("Documented Bulk API body. validate_only defaults to true. Bulk inputs differ from single-resource bodies; child creations refer to the create keys of this same job. Creations must be paused."), ...approval };
  c.tool("openai_ads_submit_bulk_job", `Submit one Bulk API job (limited preview, enabled per account) with up to 1,000 operations. Defaults to native validation only. Job acceptance is not completion: read its status and every operation outcome, then the native entities. ${WRITE_NOTE}`, bulkShape, handle(async raw => {
    const a = z.object(bulkShape).strict().parse(raw);
    client.validateBulk(a.adAccountId, a.body);
    const receipt = await mutations.run(a.adAccountId, "openai_ads_submit_bulk_job", a.requestId, a.body, a.confirm, a.confirmationToken, async () => {
      const advertiser = await client.account(a.adAccountId), targets = [];
      for (const op of a.body.operations) if ("target_resource_id" in op) targets.push(adsEditableSnapshot(await client.entity(a.adAccountId, ({ campaign: "campaigns", ad_group: "ad_groups", ad: "ads" } as const)[op.type.split(".")[0] as "campaign" | "ad_group" | "ad"], op.target_resource_id)));
      return { account: { id: advertiser.id, currency: advertiser.currency_code, timezone: advertiser.timezone }, targets };
    }, () => client.submitBulk(a.adAccountId, a.body, a.requestId), async r => ({ confirmed: null, mode: "asynchronous_job_receipt", job: await client.bulkJob(a.adAccountId, adsBulkJobId.parse(r.id)), nextAction: "Read every operation outcome and its native resource; job acceptance does not confirm advertising changes." }),
    { activationMaySpend: a.body.operations.some(op => op.input.status === "active") });
    return { ...receipt, ...((receipt as { applied?: boolean }).applied ? { jobAccepted: true, operationsVerified: false } : {}), nativeValidateOnly: a.body.validate_only };
  }));

  const uploadShape = {
    adAccountId: account,
    bytesBase64: z.string().min(4).max(6_990_508).regex(/^[A-Za-z0-9+/]+={0,2}$/).describe("The actual image bytes, base64 encoded. Never transcribe bytes from a screenshot."),
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]).describe("MIME type of these image bytes: image/png, image/jpeg or image/webp."),
    filename: z.string().regex(/^[A-Za-z0-9_.-]{1,160}$/).describe("Plain image filename without a path. Keep it unchanged between preview and confirmation."),
    ...approval,
  };
  c.tool("openai_ads_upload_image", `Upload PNG, JPEG or WebP bytes to the account and return the native file_id for a chat_card. The image must be at least 640 x 640 and at most 5 MiB. Never changes the account brand icon. ${WRITE_NOTE}`, uploadShape, handle(async raw => {
    const a = z.object(uploadShape).strict().parse(raw);
    if (a.bytesBase64.length % 4 !== 0) throw new OpenAIAdsError(400, "INVALID_IMAGE", "bytesBase64 is not valid base64.");
    const bytes = new Uint8Array(Buffer.from(a.bytesBase64, "base64"));
    const d = imageDimensions(bytes, a.mimeType);
    if (!d || d.width < 640 || d.height < 640 || bytes.byteLength > 5 * 1024 * 1024) throw new OpenAIAdsError(400, "INVALID_IMAGE", "Use a valid PNG, JPEG or WebP of at least 640 x 640 and at most 5 MiB.");
    client.scope(a.adAccountId);
    if (!client.writesEnabled) throw new OpenAIAdsError(403, "WRITES_DISABLED", "ChatGPT Ads image uploads are disabled.");
    const summary = { sha256: await adsHash(a.bytesBase64), byteLength: bytes.byteLength, mimeType: a.mimeType, filename: a.filename, dimensions: d };
    return mutations.run(a.adAccountId, "openai_ads_upload_image", a.requestId, summary, a.confirm, a.confirmationToken, () => accountSnapshot(client, a.adAccountId), () => client.uploadImage(a.adAccountId, bytes, a.mimeType, a.filename), async r => ({ confirmed: typeof r.file_id === "string", mode: "native_upload_receipt" }));
  }));

  const urlShape = { adAccountId: account, imageUrl: z.string().url().startsWith("https://").max(4000).describe("Exact public HTTPS URL of a PNG, JPEG or WebP image the person approved. OpenAI downloads and validates it; this server never fetches it."), ...approval };
  c.tool("openai_ads_upload_image_url", `Import a public HTTPS image through the documented JSON upload endpoint and return the native file_id. OpenAI fetches and validates the image. Private, loopback and credential-bearing URLs are refused. Account branding is untouched. ${WRITE_NOTE}`, urlShape, handle(async raw => {
    const a = z.object(urlShape).strict().parse(raw);
    client.scope(a.adAccountId);
    if (!client.writesEnabled) throw new OpenAIAdsError(403, "WRITES_DISABLED", "ChatGPT Ads uploads are disabled.");
    return mutations.run(a.adAccountId, "openai_ads_upload_image_url", a.requestId, { imageUrl: a.imageUrl }, a.confirm, a.confirmationToken, () => accountSnapshot(client, a.adAccountId), () => client.uploadImageUrl(a.adAccountId, a.imageUrl), async r => ({ confirmed: typeof r.file_id === "string", mode: "native_upload_receipt" }));
  }));

  // Renames keep the saved approval. The request ID derives from the entity's exact editable state and
  // the new name, so confirm applies that same preview and any change in between yields a new request.
  for (const [level, kind, param, path] of [["campaign", "campaigns", "campaignId", "campaign_id"], ["ad_group", "ad_groups", "adGroupId", "ad_group_id"], ["ad", "ads", "adId", "ad_id"]] as const) {
    const tool = `openai_ads_rename_${level}`, op = OPENAI_ADS_OPERATIONS.find(o => o.name === `openai_ads_update_${level}`)!;
    const prefix = { campaign: "cmpn", ad_group: "adgrp", ad: "ad" }[level];
    const renameShape = {
      adAccountId: account,
      [param]: z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9_-]{1,128}$`)).describe(`Native ${level.replace("_", " ")} ID (${prefix}_) in the configured account.`),
      name: z.string().trim().min(3).max(1000).describe("New name, 3 to 1,000 characters. The name is the only thing the call changes."),
      confirm: z.boolean().default(false).describe("false returns a preview and changes nothing. true applies the rename after the person approved it."),
    };
    c.tool(tool, `Rename one ChatGPT Ads ${level.replace("_", " ")}. The name is the only field that changes. Previews by default; confirm:true applies it once the person approves. Nothing is retried automatically.`, renameShape, handle(async raw => {
      const a = z.object(renameShape).strict().parse(raw) as Record<string, any>;
      const native = { [path]: a[param], body: { name: a.name } };
      client.validateMutation(a.adAccountId, op, native);
      const current = adsEditableSnapshot(await client.entity(a.adAccountId, kind, a[param]));
      // Already so named, typically after an applied rename: nothing to save or send.
      if (current.name === a.name) return { applied: false, unchanged: true, action: tool, change: { target: a[param], newName: a.name }, message: "The entity already has this name. Nothing was sent." };
      const h = await adsHash({ account: a.adAccountId, tool, current, name: a.name });
      const requestId = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${(8 | parseInt(h[16], 16) & 3).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
      const run = (confirm: boolean, token?: string) => mutations.run(a.adAccountId, op.name, requestId, native, confirm, token, () => capture(client, a.adAccountId, op, native), () => client.native(a.adAccountId, op.name, native, requestId), r => verification(client, a.adAccountId, op, native, r));
      const saved = await run(false) as Record<string, any>;
      return a.confirm ? { ...await run(true, saved.confirmationToken), action: tool } : { ...saved, action: tool };
    }));
  }
}
