/**
 * chatgpt-ads-mcp-server: an open-source MCP server for the ChatGPT Ads Advertiser API.
 * Copyright 2026 GetMCPAds. https://www.getmcpads.com
 * SPDX-License-Identifier: Apache-2.0
 *
 * Account-scoped Advertiser API client. One fixed host, strict native contracts,
 * bounded responses and no automatic retries.
 */
import { z } from "zod";
import { ACCOUNT_ID_PATTERN, type OpenAIAdsConfig } from "./config.js";
import { MAX_RESPONSE_BYTES, OPENAI_ADS_API_BASE, REQUEST_TIMEOUT_MS, ResponseTooLargeError, isPublicHttpsUrl, isRedirect, readBounded } from "./http.js";
import { adsOperation, adsOperationShape, type AdsOperation } from "./schema.js";
import { adsBulkBody, adsBulkJobId, adsBulkResultsQuery } from "./bulk.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
export const OPENAI_ADS_DOCS = "https://developers.openai.com/ads/api-reference";
export const OPENAI_ADS_METRICS = ["impressions", "clicks", "spend", "ctr", "cpc", "cpm", "conversions", "cpa", "post_click_cvr", "order_created_attributed_sales", "order_created_roas"] as const;
export type OpenAIAdsMetric = (typeof OPENAI_ADS_METRICS)[number];
export const OPENAI_ADS_LEVELS = ["ad_account", "campaign", "ad_group", "ad"] as const;
export type OpenAIAdsLevel = (typeof OPENAI_ADS_LEVELS)[number];
export const OPENAI_ADS_BREAKDOWNS = ["country", "device", "platform"] as const;
export type OpenAIAdsBreakdown = (typeof OPENAI_ADS_BREAKDOWNS)[number];
export const OPENAI_ADS_DELIVERY_METRICS = ["impressions", "clicks", "spend", "ctr", "cpc", "cpm"] as const;
export const openaiAdsAttributionSchema = z.object({
  attribution_window_days: z.union([z.literal(7), z.literal(14), z.literal(30)]).default(30),
  view_through_attribution_window_days: z.union([z.literal(0), z.literal(1)]).default(1),
  attribution_time_basis: z.enum(["ad_event_time", "conversion_time"]).default("ad_event_time"),
}).strict();
export type OpenAIAdsAttributionInput = z.input<typeof openaiAdsAttributionSchema>;
export const OPENAI_ADS_ATTRIBUTION = "Goal conversions include click-through and view-through attribution: 30-day click / 1-day view, grouped by ad interaction date. Purchase sales include attributed order_created events. Results are not deduplicated against other providers.";
export const OPENAI_ADS_REPORT_NOTES = ["Spend, CPC and CPM use major units of the account currency; campaign budgets use micros.", "Native CTR and post-click CVR are fractions. Missing or unavailable values remain null, never zero.", "Recent delivery, finalized cost and attributed conversions can become available at different times.", OPENAI_ADS_ATTRIBUTION];

export function openaiAdsAttributionDescription(input: OpenAIAdsAttributionInput = {}): string {
  const a = openaiAdsAttributionSchema.parse(input);
  return `Goal conversions use ${a.attribution_window_days}-day click / ${a.view_through_attribution_window_days}-day view attribution${a.view_through_attribution_window_days === 0 ? " (view-through excluded)" : ""}, grouped by ${a.attribution_time_basis === "conversion_time" ? "conversion date" : "ad interaction date"}. Purchase sales include attributed order_created events. Results are not deduplicated against other providers.`;
}

export type OpenAIAdsAccount = { id: string; name: string; currency_code: string; timezone: string; status?: string; url?: string; review?: { status?: string; reason?: string } };
export type OpenAIAdsPage = { data: Record<string, unknown>[]; has_more: boolean; first_id?: string; last_id?: string };
export type OpenAIAdsReportQuery = {
  adAccountId: string; since: string; until: string; level: OpenAIAdsLevel;
  metrics: OpenAIAdsMetric[]; timeGranularity: "daily" | "none"; maxRows?: number;
  breakdown?: OpenAIAdsBreakdown; attribution?: OpenAIAdsAttributionInput;
};
type ErrorDetails = { field: string; minimum: number; unit: "micros" };

export class OpenAIAdsError extends Error {
  readonly retryable = false;
  constructor(public status: number, public code: string, message: string, public requestId?: string, public details?: ErrorDetails, public nativeMessage?: string) { super(message); this.name = "OpenAIAdsError"; }
}

const invalid = (message: string): never => { throw new OpenAIAdsError(502, "INVALID_RESPONSE", message); };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const entityId = (id: string, prefix: string) => {
  if (!new RegExp(`^${prefix}_[A-Za-z0-9_-]{1,128}$`).test(id)) throw new OpenAIAdsError(400, "INVALID_ENTITY", "Use an exact native ChatGPT Ads entity ID.");
  return id;
};
const cleanId = (v: string | null) => v?.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 160) || null;
const MINIMUM_DAILY_BUDGET = /^400: Daily campaign budget must be at least (\d{1,15}) micros\.$/;

/** Removes the active key and any bearer-looking secret from provider text before it leaves this module. */
export function redact(text: string, secret: string): string {
  const out = secret ? text.split(secret).join("[REDACTED]") : text;
  return out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]").replace(/\b(sk|ak|key)[-_][A-Za-z0-9_-]{16,}\b/g, "[REDACTED]");
}

export type EntityKind = "campaigns" | "ad_groups" | "ads";

export class OpenAIAdsClient {
  private verified = false;
  constructor(private readonly config: OpenAIAdsConfig) {}

  get writesEnabled(): boolean { return this.config.enableWrites; }
  get activationEnabled(): boolean { return this.config.enableActivation; }

  /** The Advertiser API account is implicit in the key. A supplied ID never switches it. */
  scope(id: unknown): void {
    if (typeof id !== "string" || !ACCOUNT_ID_PATTERN.test(id)) throw new OpenAIAdsError(400, "INVALID_ACCOUNT", "Use the exact ChatGPT Ads adacct_ identifier.");
    if (id !== this.config.accountId) throw new OpenAIAdsError(403, "ACCOUNT_NOT_SELECTED", "This ChatGPT Ads account is not the one configured in OPENAI_ADS_ACCOUNT_ID.");
  }

  /** Confirms once per process that the key belongs to the configured account. */
  private async ready(id: string): Promise<void> {
    this.scope(id);
    if (!this.verified) await this.account(id);
  }

  private async request(method: string, path: string, params = new URLSearchParams(), requestBody?: Record<string, unknown> | FormData, idempotencyKey?: string): Promise<Record<string, unknown>> {
    const multipart = requestBody instanceof FormData;
    const headers: Record<string, string> = { Authorization: `Bearer ${this.config.apiKey}`, Accept: "application/json" };
    if (requestBody && !multipart) headers["Content-Type"] = "application/json";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const url = `${OPENAI_ADS_API_BASE}${path}${params.size ? `?${params}` : ""}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method, headers, ...(requestBody ? { body: multipart ? requestBody : JSON.stringify(requestBody) } : {}),
        redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const cause = String((error as { cause?: { message?: string } })?.cause?.message ?? "");
      if (/redirect/i.test(cause)) throw new OpenAIAdsError(502, "REDIRECT_REFUSED", "ChatGPT Ads answered with a redirect. Redirects are never followed, so the key was not forwarded. No automatic retry was made.");
      throw new OpenAIAdsError(502, "TRANSPORT_ERROR", "ChatGPT Ads could not be reached or did not answer in time. No automatic retry was made.");
    }
    const requestId = cleanId(response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? response.headers.get("cf-ray")) ?? undefined;
    if (isRedirect(response)) {
      await response.body?.cancel().catch(() => undefined);
      throw new OpenAIAdsError(response.status, "REDIRECT_REFUSED", `ChatGPT Ads returned an unexpected HTTP ${response.status} redirect. Redirects are never followed. No automatic retry was made.`, requestId);
    }
    let text: string;
    try { text = await readBounded(response, MAX_RESPONSE_BYTES); }
    catch (error) {
      if (error instanceof ResponseTooLargeError) throw new OpenAIAdsError(502, "RESPONSE_TOO_LARGE", "The ChatGPT Ads response exceeded the 8 MiB bound. Narrow the request, for example with a smaller limit or a shorter period.", requestId);
      throw new OpenAIAdsError(502, "TRANSPORT_ERROR", "The ChatGPT Ads response was interrupted. No automatic retry was made.", requestId);
    }
    let body: unknown;
    try { body = JSON.parse(redact(text, this.config.apiKey)); } catch { body = null; }
    if (!response.ok) throw this.providerError(response.status, path, body, requestId);
    // The API can answer 200 with an error object. Treat it as an error, never as data.
    if (!object(body)) invalid("ChatGPT Ads did not return a valid JSON object.");
    if ((body as Record<string, unknown>).error) throw this.providerError(502, path, body, requestId);
    return body as Record<string, unknown>;
  }

  private providerError(status: number, path: string, body: unknown, requestId?: string): OpenAIAdsError {
    const edge = object(body) && (body.error_code === 1010 || body.error_code === "1010" || body.error_name === "browser_signature_banned");
    const code = edge ? "CLOUDFLARE_BLOCKED" : status === 404 && path.startsWith("/bulk_mutation_jobs") ? "BULK_NOT_ENABLED" : status === 401 ? "AUTHENTICATION_FAILED" : status === 403 ? "ACCESS_DENIED" : status === 404 ? "NOT_FOUND" : status === 409 ? "CONFLICT" : status === 429 ? "RATE_LIMITED" : status === 400 || status === 422 ? "NATIVE_VALIDATION_FAILED" : "PROVIDER_ERROR";
    const message = edge ? "Cloudflare rejected this ChatGPT Ads client (1010). Stop retries and contact OpenAI Ads support with the HTTP status, UTC time and request reference."
      : status === 401 ? "ChatGPT Ads rejected this API key. Check OPENAI_ADS_API_KEY, or create a new Advertiser API key in Ads Manager settings."
      : status === 403 ? "ChatGPT Ads denied access. The key may lack this feature or account; ask your OpenAI Ads contact. No automatic retry was made."
      : code === "BULK_NOT_ENABLED" ? "The limited-preview Bulk API is not enabled for this ad account. Ask your OpenAI Ads contact to confirm access. No retry was made."
      : status === 404 ? "ChatGPT Ads found no such resource for this account, or the endpoint is not enabled for it."
      : status === 429 ? "ChatGPT Ads throttled this request (600 requests per minute per endpoint, 1,200 overall). Wait before trying again. No automatic retry was made."
      : status === 400 || status === 422 ? "ChatGPT Ads rejected the request. Correct it using nativeMessage and the tool schema."
      : status === 502 ? "ChatGPT Ads returned an error object inside a successful response. No automatic retry was made."
      : "ChatGPT Ads returned an error. No automatic retry was made.";
    const nativeError = object(body) && object(body.error) ? body.error : undefined;
    const raw = typeof nativeError?.message === "string" ? nativeError.message : undefined;
    const minimum = raw ? raw.match(MINIMUM_DAILY_BUDGET) : null;
    const details = minimum && Number.isSafeInteger(Number(minimum[1])) ? { field: "budget.daily_spend_limit_micros", minimum: Number(minimum[1]), unit: "micros" as const } : undefined;
    // Only validation-style errors carry native text, already redacted and bounded. Authentication errors never do.
    const nativeMessage = raw && [400, 404, 409, 422, 502].includes(status) && !edge ? redact(raw, this.config.apiKey).slice(0, 500) : undefined;
    return new OpenAIAdsError(status, code, details ? `ChatGPT Ads requires a daily campaign budget of at least ${details.minimum} account-currency micros.` : message, requestId, details, nativeMessage);
  }

  private async page(path: string, params: URLSearchParams): Promise<OpenAIAdsPage> {
    const body = await this.request("GET", path, params);
    if (!Array.isArray(body.data) || !body.data.every(object) || typeof body.has_more !== "boolean") invalid("ChatGPT Ads returned an incomplete page; no complete result can be inferred.");
    if (body.has_more && (typeof body.last_id !== "string" || !body.last_id)) invalid("ChatGPT Ads omitted its next-page cursor.");
    return body as OpenAIAdsPage;
  }

  /** Reads the account the key belongs to and refuses it unless it is the configured one. */
  async account(adAccountId: string): Promise<OpenAIAdsAccount> {
    this.scope(adAccountId);
    const body = await this.request("GET", "/ad_account");
    if (typeof body.id !== "string" || !ACCOUNT_ID_PATTERN.test(body.id)) invalid("ChatGPT Ads returned an invalid account ID.");
    if (body.id !== adAccountId) {
      this.verified = false;
      throw new OpenAIAdsError(403, "ACCOUNT_MISMATCH", "OPENAI_ADS_API_KEY belongs to a different ad account than OPENAI_ADS_ACCOUNT_ID. No other request was sent.");
    }
    if (typeof body.name !== "string" || typeof body.currency_code !== "string" || !/^[A-Z]{3}$/.test(body.currency_code) || typeof body.timezone !== "string") invalid("ChatGPT Ads account metadata is incomplete.");
    try { new Intl.DateTimeFormat("en", { timeZone: String(body.timezone) }); } catch { invalid("ChatGPT Ads returned an invalid account timezone."); }
    this.verified = true;
    return body as OpenAIAdsAccount;
  }

  async list(adAccountId: string, kind: EntityKind, query: { parentId?: string; limit?: number; after?: string; before?: string; name?: string; include?: "serving_issues"[]; order?: "asc" | "desc" } = {}) {
    this.scope(adAccountId);
    const limit = query.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new OpenAIAdsError(400, "INVALID_LIMIT", "List page size must be between 1 and 500.");
    const p = new URLSearchParams({ limit: String(limit), order: query.order ?? "desc" });
    if (kind === "ad_groups" && query.parentId) p.set("campaign_id", entityId(query.parentId, "cmpn"));
    if (kind === "ads" && query.parentId) p.set("ad_group_id", entityId(query.parentId, "adgrp"));
    if (query.after) p.set("after", query.after);
    if (query.before) p.set("before", query.before);
    if (query.name) p.set("name", query.name);
    for (const item of query.include ?? []) p.append("include[]", item);
    await this.ready(adAccountId);
    return this.page(`/${kind}`, p);
  }

  async entity(adAccountId: string, kind: EntityKind, id: string, include: "serving_issues"[] = []) {
    this.scope(adAccountId);
    const params = new URLSearchParams();
    for (const item of include) params.append("include[]", item);
    const path = `/${kind}/${entityId(id, { campaigns: "cmpn", ad_groups: "adgrp", ads: "ad" }[kind])}`;
    await this.ready(adAccountId);
    return this.request("GET", path, params);
  }

  /** Local checks that run before any network call. Native validation stays authoritative. */
  validateMutation(adAccountId: string, op: AdsOperation, args: Record<string, any>) {
    this.scope(adAccountId);
    if (!op.write) return;
    if (!this.config.enableWrites) throw new OpenAIAdsError(403, "WRITES_DISABLED", "ChatGPT Ads writes are disabled. Set OPENAI_ADS_ENABLE_WRITES=true to enable them.");
    const status = args.body?.status;
    if (op.idempotentCreate && status !== "paused") throw new OpenAIAdsError(400, "PAUSED_CREATION_REQUIRED", "Campaigns, ad groups and ads must be created paused. Activation needs a separate approved operation.");
    if ((op.path.endsWith("/activate") || status === "active") && !this.config.enableActivation) throw new OpenAIAdsError(403, "ACTIVATION_DISABLED", "ChatGPT Ads activation is disabled. Set OPENAI_ADS_ENABLE_ACTIVATION=true to allow changes that can start delivery and spend. No delivery was enabled.");
    const budget = args.body?.budget;
    if (budget && (Boolean(budget.lifetime_spend_limit_micros) === Boolean(budget.daily_spend_limit_micros))) throw new OpenAIAdsError(400, "INVALID_BUDGET", "Supply exactly one daily or lifetime budget in integer account-currency micros.");
    if (op.name === "openai_ads_create_campaign" && !budget) throw new OpenAIAdsError(400, "INVALID_BUDGET", "Campaign creation requires an explicit daily or lifetime budget.");
    if (op.name === "openai_ads_create_campaign" && args.body.bidding_type === "conversions" && args.body.conversion_event_setting_ids?.length !== 1) throw new OpenAIAdsError(400, "CONVERSION_GOAL_REQUIRED", "A conversion campaign needs exactly one active standard event setting from this account.");
    if (op.name === "openai_ads_create_campaign" && args.body.mode === "product_feed" && !args.body.product_feed_id) throw new OpenAIAdsError(400, "PRODUCT_FEED_REQUIRED", "A product-feed campaign needs its account-owned native feed ID.");
    if (op.name === "openai_ads_create_campaign" && args.body.mode === "business_agent" && !args.body.business_agent_id) throw new OpenAIAdsError(400, "BUSINESS_AGENT_REQUIRED", "A business-agent campaign needs an existing native business_agent_id. This API does not provision business agents.");
    const bidding = args.body?.bidding_config;
    if (bidding?.strategy === "fixed_bid" && !bidding.max_bid_micros) throw new OpenAIAdsError(400, "FIXED_BID_REQUIRED", "Fixed bidding needs max_bid_micros.");
    if (bidding?.strategy?.startsWith("maximize_") && bidding.max_bid_micros !== undefined) throw new OpenAIAdsError(400, "AUTOBID_AMOUNT_FORBIDDEN", "Maximize Results omits max_bid_micros.");
    if (args.body?.start_time && args.body?.end_time && args.body.start_time >= args.body.end_time) throw new OpenAIAdsError(400, "INVALID_SCHEDULE", "Campaign end_time must be later than start_time.");
    const creative = args.body?.creative;
    if (creative?.type === "chat_card" && (!creative.file_id || !creative.target_url || !/^https:\/\//.test(creative.target_url))) throw new OpenAIAdsError(400, "INVALID_CREATIVE", "A chat_card needs an uploaded file_id and an HTTPS destination.");
    if (creative?.type === "product_ad_template" && (creative.file_id || creative.target_url || creative.image_crop)) throw new OpenAIAdsError(400, "INVALID_CREATIVE", "A product template obtains its image and destination from its feed.");
    const crop = creative?.image_crop;
    if (crop && (!["x", "y", "width", "height"].every(k => Number.isFinite(crop[k]) && crop[k] >= 0 && crop[k] <= 1) || crop.width <= 0 || crop.height <= 0 || crop.x + crop.width > 1 || crop.y + crop.height > 1)) throw new OpenAIAdsError(400, "INVALID_IMAGE_CROP", "Image crop must be positive and inside the normalized source image.");
  }

  async native(adAccountId: string, name: string, args: Record<string, any>, requestId?: string) {
    this.scope(adAccountId);
    const op = adsOperation(name);
    const parsed = z.object(adsOperationShape(op)).strict().parse(args) as Record<string, any>;
    this.validateMutation(adAccountId, op, parsed);
    let path = op.path;
    for (const p of op.parameters.filter(p => p.in === "path")) path = path.replace(`{${p.name}}`, encodeURIComponent(String(parsed[p.name])));
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries((parsed.query ?? {}) as Record<string, unknown>)) {
      if (value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) params.append(Array.isArray(value) && !key.endsWith("[]") ? `${key}[]` : key, typeof item === "object" ? JSON.stringify(item) : String(item));
    }
    if (op.idempotentCreate && !requestId) throw new OpenAIAdsError(400, "IDEMPOTENCY_REQUIRED", "Supply a stable requestId for creation.");
    await this.ready(adAccountId);
    return this.request(op.method, path, params, parsed.body as Record<string, unknown> | undefined, op.idempotentCreate ? requestId : undefined);
  }

  async uploadImage(adAccountId: string, bytes: Uint8Array, mimeType: string, filename: string) {
    this.scope(adAccountId);
    if (!this.config.enableWrites) throw new OpenAIAdsError(403, "WRITES_DISABLED", "ChatGPT Ads image uploads are disabled.");
    if (!/^(image\/png|image\/jpeg|image\/webp)$/.test(mimeType) || !bytes.byteLength || bytes.byteLength > 5 * 1024 * 1024) throw new OpenAIAdsError(400, "INVALID_IMAGE", "Upload a PNG, JPEG or WebP image of at most 5 MiB.");
    const form = new FormData();
    form.set("file", new Blob([Uint8Array.from(bytes).buffer], { type: mimeType }), filename);
    await this.ready(adAccountId);
    const body = await this.request("POST", "/upload", new URLSearchParams(), form);
    if (typeof body.file_id !== "string" || !body.file_id) invalid("ChatGPT Ads omitted the uploaded file ID. Inspect the upload before another submission.");
    return body;
  }

  async uploadImageUrl(adAccountId: string, imageUrl: string) {
    this.scope(adAccountId);
    if (!this.config.enableWrites) throw new OpenAIAdsError(403, "WRITES_DISABLED", "ChatGPT Ads image URL uploads are disabled.");
    if (!isPublicHttpsUrl(imageUrl)) throw new OpenAIAdsError(400, "INVALID_IMAGE_URL", "Supply a public HTTPS image URL without embedded credentials, a fragment or a private address.");
    await this.ready(adAccountId);
    const body = await this.request("POST", "/upload", new URLSearchParams(), { image_url: imageUrl });
    if (typeof body.file_id !== "string" || !body.file_id) invalid("ChatGPT Ads omitted the uploaded file ID. Inspect the upload before another submission.");
    return body;
  }

  validateBulk(adAccountId: string, body: unknown) {
    this.scope(adAccountId);
    const parsed = adsBulkBody.parse(body);
    if (!this.config.enableWrites) throw new OpenAIAdsError(403, "WRITES_DISABLED", "ChatGPT Ads bulk submissions are disabled.");
    for (const op of parsed.operations) {
      if (op.type.endsWith(".create") && op.input.status !== "paused") throw new OpenAIAdsError(400, "PAUSED_CREATION_REQUIRED", "Bulk hierarchy creations must be paused.");
      if (op.input.status === "active" && !this.config.enableActivation) throw new OpenAIAdsError(403, "ACTIVATION_DISABLED", "Bulk activation is disabled. Set OPENAI_ADS_ENABLE_ACTIVATION=true to allow it.");
    }
    return parsed;
  }

  async submitBulk(adAccountId: string, body: unknown, requestId: string) {
    const parsed = this.validateBulk(adAccountId, body);
    if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new OpenAIAdsError(400, "IDEMPOTENCY_REQUIRED", "Use a stable bulk request UUID.");
    await this.ready(adAccountId);
    return this.request("POST", "/bulk_mutation_jobs", new URLSearchParams(), parsed, requestId);
  }

  async bulkJob(adAccountId: string, id: string) {
    this.scope(adAccountId);
    const jobId = adsBulkJobId.parse(id);
    await this.ready(adAccountId);
    const result = await this.request("GET", `/bulk_mutation_jobs/${jobId}`);
    if (result.id !== id || !["pending", "in_progress", "completed", "partially_failed", "failed"].includes(String(result.status))) invalid("Bulk job readback did not match the exact acknowledged job.");
    return result;
  }

  async bulkResults(adAccountId: string, id: string, query: unknown = {}) {
    this.scope(adAccountId);
    const jobId = adsBulkJobId.parse(id), parsed = adsBulkResultsQuery.parse(query), params = new URLSearchParams({ limit: String(parsed.limit) });
    if (parsed.after) params.set("after", parsed.after);
    await this.ready(adAccountId);
    const result = await this.request("GET", `/bulk_mutation_jobs/${jobId}/operations`, params);
    if (!Array.isArray(result.data) || typeof result.has_more !== "boolean") invalid("Bulk operation results are incomplete. Do not infer success.");
    return result;
  }

  async insights(query: OpenAIAdsReportQuery) {
    this.scope(query.adAccountId);
    if (!OPENAI_ADS_LEVELS.includes(query.level) || !["daily", "none"].includes(query.timeGranularity) || !query.metrics.length || query.metrics.some(m => !OPENAI_ADS_METRICS.includes(m))) throw new OpenAIAdsError(400, "INVALID_REPORT", "Choose documented ChatGPT Ads report levels and metrics.");
    if (query.breakdown !== undefined && !OPENAI_ADS_BREAKDOWNS.includes(query.breakdown)) throw new OpenAIAdsError(400, "INVALID_REPORT", "Choose one country, device or platform breakdown per report.");
    if (query.breakdown && query.metrics.some(m => !(OPENAI_ADS_DELIVERY_METRICS as readonly string[]).includes(m))) throw new OpenAIAdsError(400, "UNSUPPORTED_BREAKDOWN_METRICS", "Segmented delivery reports support impressions, clicks, spend, CTR, CPC and CPM. Use openai_ads_get_conversion_insights for country or device conversions; platform conversions are unavailable.");
    const parsedAttribution = openaiAdsAttributionSchema.safeParse(query.attribution ?? {});
    if (!parsedAttribution.success) throw new OpenAIAdsError(400, "INVALID_ATTRIBUTION", "Choose 7, 14 or 30 click days, 0 or 1 view days and ad_event_time or conversion_time.");
    const attribution = parsedAttribution.data;
    const realDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d;
    const days = (Date.parse(query.until) - Date.parse(query.since)) / 86400000 + 1;
    if (!realDate(query.since) || !realDate(query.until) || days < 1 || days > 365) throw new OpenAIAdsError(400, "INVALID_DATES", "Choose an inclusive period of 1 to 365 real calendar days.");
    const maxRows = query.maxRows ?? 10_000;
    if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 10_000) throw new OpenAIAdsError(400, "INVALID_LIMIT", "Report row limit must be between 1 and 10,000.");
    const p = new URLSearchParams({ aggregation_level: query.level, time_granularity: query.timeGranularity, limit: String(Math.min(maxRows, 2000)), ...Object.fromEntries(Object.entries(attribution).map(([key, value]) => [key, String(value)])) });
    // Omitting timezone delegates local day boundaries, including DST, to the verified account.
    p.append("time_ranges[]", JSON.stringify({ type: "date_range", since: query.since, until: query.until }));
    p.append("fields[]", `${query.level}.id`); p.append("fields[]", `${query.level}.name`);
    if (query.timeGranularity === "daily") p.append("fields[]", "metadata.readable_time");
    if (query.breakdown) {
      p.append("segments[]", query.breakdown);
      p.append("fields[]", { country: "country.name", device: "device.type", platform: "platform" }[query.breakdown]);
    }
    for (const metric of new Set(query.metrics)) p.append("fields[]", (OPENAI_ADS_DELIVERY_METRICS as readonly string[]).includes(metric) ? `${query.breakdown ?? query.level}.${metric}` : metric);
    await this.ready(query.adAccountId);
    const rows: Record<string, unknown>[] = [], cursors = new Set<string>();
    let more = false;
    do {
      const page = await this.page("/ad_account/insights", p);
      rows.push(...page.data); more = page.has_more;
      if (rows.length >= maxRows) break;
      if (more) {
        const cursor = page.last_id!;
        if (cursors.has(cursor) || !page.data.length) invalid("ChatGPT Ads repeated a pagination cursor. The extraction was stopped.");
        cursors.add(cursor); p.set("after", cursor); p.set("limit", String(Math.min(maxRows - rows.length, 2000)));
      }
    } while (more);
    const selectedRows = rows.slice(0, maxRows).map(row => {
      if (!query.breakdown) return row;
      const segment = query.breakdown;
      const dimension = { country: "country_name", device: "device_type", platform: "platform" }[segment];
      if (!Object.hasOwn(row, dimension)) invalid("ChatGPT Ads omitted the requested breakdown dimension. Entity totals were not substituted.");
      // Grouped wire metrics are prefixed. A parent total repeated on each segment row is never used.
      return { ...row, [segment]: row[dimension], ...Object.fromEntries(query.metrics.map(metric => [metric, row[`${segment}_${metric}`] ?? null])) };
    });
    return {
      rows: selectedRows, truncated: more || rows.length > maxRows, partial: false, level: query.level, period: { since: query.since, until: query.until }, timeGranularity: query.timeGranularity, breakdown: query.breakdown ?? null,
      attributionSettings: attribution, attribution: openaiAdsAttributionDescription(attribution),
      notes: [...OPENAI_ADS_REPORT_NOTES.slice(0, -1), openaiAdsAttributionDescription(attribution), ...(query.breakdown ? ["One delivery breakdown per report. Do not sum parent totals repeated across segment rows. Platform conversions are unavailable; country and device conversions use openai_ads_get_conversion_insights."] : [])],
    };
  }
}
