/**
 * chatgpt-ads-mcp-server: an open-source MCP server for the ChatGPT Ads Advertiser API.
 * Copyright 2026 GetMCPAds. https://www.getmcpads.com
 * SPDX-License-Identifier: Apache-2.0
 */
import { z } from "zod";
import {
  OpenAIAdsError, OPENAI_ADS_BREAKDOWNS, OPENAI_ADS_DELIVERY_METRICS, OPENAI_ADS_DOCS, OPENAI_ADS_LEVELS, OPENAI_ADS_METRICS,
  OPENAI_ADS_REPORT_NOTES, openaiAdsAttributionSchema, type OpenAIAdsReportQuery,
} from "./client.js";
import { ok, toolError } from "./tool-errors.js";
import type { ToolShape } from "./tool-quality.js";
import { accountParam, type Collector, type ToolContext } from "./context.js";
import { registerOpenAINative } from "./native-tools.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
const campaignId = z.string().regex(/^cmpn_[A-Za-z0-9_-]{1,128}$/).describe("Native campaign ID (cmpn_) in the configured account.");
const adGroupId = z.string().regex(/^adgrp_[A-Za-z0-9_-]{1,128}$/).describe("Native ad group ID (adgrp_) in the configured account.");
const adId = z.string().regex(/^ad_[A-Za-z0-9_-]{1,128}$/).describe("Native ad ID (ad_) in the configured account.");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
}, "Use a real calendar date in YYYY-MM-DD format.");
const include = z.array(z.literal("serving_issues")).max(1).optional().describe("Add serving_issues to receive native reasons why this entity cannot serve. A paused state is intentional, not an issue.");
const pagination = {
  limit: z.number().int().min(1).max(500).prefault(100).describe("Page size, 1 to 500. Defaults to 100."),
  after: z.string().min(1).max(4096).optional().describe("Next-page cursor: the previous page's last_id, only when has_more is true."),
  before: z.string().min(1).max(4096).optional().describe("Previous-page cursor: a first_id returned by a later page."),
  name: z.string().min(3).max(1000).optional().describe("Return only entities whose name matches this text, 3 to 1,000 characters."),
  include,
  order: z.enum(["asc", "desc"]).prefault("desc").describe("Sort by creation time. Defaults to desc, newest first."),
};

/** Native signed image links can already be stale in a list response. Their expiry is never extended. */
function usableImageUrl(value: unknown, marginMs = 0): value is string {
  if (typeof value !== "string" || !value) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    const expiry = url.searchParams.get("se");
    return !expiry || Date.parse(expiry) > Date.now() + marginMs;
  } catch { return false; }
}

export function registerOpenAIAdsReads(collector: Collector, ctx: ToolContext): void {
  const { client } = ctx;
  const register = (name: string, description: string, shape: ToolShape, handler: (a: Record<string, any>) => Promise<unknown>) => collector.tool(name, description, shape, async args => {
    try { return ok(await handler(z.object(shape).strict().parse(args))); }
    catch (error) { return toolError(error, false, ctx.secret); }
  });

  register("openai_ads_get_account", "Read the configured ChatGPT Ads account: name, currency, time zone, status and brand review. Also verifies that the API key belongs to OPENAI_ADS_ACCOUNT_ID. Run it first.", { adAccountId: accountParam }, a => client.account(a.adAccountId));
  register("openai_ads_get_campaigns", "List one page of campaigns in the account. Follow last_id only when has_more is true. Budget amounts use integer account-currency micros.", { adAccountId: accountParam, ...pagination }, a => client.list(a.adAccountId, "campaigns", a));
  register("openai_ads_get_campaign", "Read one campaign with its native status, budget, schedule and targeting.", { adAccountId: accountParam, campaignId, include }, a => client.entity(a.adAccountId, "campaigns", a.campaignId, a.include));
  register("openai_ads_get_ad_groups", "List one page of ad groups in a campaign. Native ad group IDs start with adgrp_. Follow last_id only when has_more is true.", { adAccountId: accountParam, campaignId, ...pagination }, a => client.list(a.adAccountId, "ad_groups", { ...a, parentId: a.campaignId }));
  register("openai_ads_get_ad_group", "Read one ad group with its native bidding, context hints and product set.", { adAccountId: accountParam, adGroupId, include }, a => client.entity(a.adAccountId, "ad_groups", a.adGroupId, a.include));
  register("openai_ads_get_ads", "List one page of ads in an ad group with native creative metadata and review status. Follow last_id only when has_more is true.", { adAccountId: accountParam, adGroupId, ...pagination }, a => client.list(a.adAccountId, "ads", { ...a, parentId: a.adGroupId }));
  register("openai_ads_get_ad", "Read one ad with its creative and review status. No preview or change is requested.", { adAccountId: accountParam, adId, include }, a => client.entity(a.adAccountId, "ads", a.adId, a.include));
  register("openai_ads_list_ad_creatives", "List chat card creatives of the account or of one ad group, 20 ads per page, or read up to 60 exact adIds. Each item has the native file_id, signed image_url, title, body, destination and review status. An expired image link is refreshed with one ad read. Follow nextCursor when hasMore.", {
    adAccountId: accountParam,
    adGroupId: adGroupId.optional().describe("Optional ad group (adgrp_) to list. Omit to list ads across the account."),
    adIds: z.array(adId).min(1).max(60).optional().describe("Up to 60 exact ad IDs to read. Cannot be combined with adGroupId or after."),
    limit: z.number().int().min(1).max(20).prefault(20).describe("Ads per page, 1 to 20. Defaults to 20."),
    after: z.string().min(1).max(4096).optional().describe("The nextCursor of the previous page, only when hasMore is true."),
  }, async a => {
    if (a.adIds && (a.adGroupId || a.after)) throw new OpenAIAdsError(400, "INVALID_FILTER", "Use exact adIds or a paginated ad group or account listing, not both.");
    const readAd = async (id: string) => {
      const current = await client.entity(a.adAccountId, "ads", id);
      if (current.id !== id) throw new OpenAIAdsError(502, "INVALID_RESPONSE", "The creative readback returned another ad.");
      return current;
    };
    const ids = a.adIds ? [...new Set(a.adIds as string[])] : null;
    const selected: Record<string, unknown>[] = [];
    if (ids) for (const id of ids) selected.push(await readAd(id));
    const page = ids ? { data: selected, has_more: false, last_id: undefined } : await client.list(a.adAccountId, "ads", { limit: a.limit, after: a.after, parentId: a.adGroupId });
    const hydrated: Record<string, unknown>[] = [], unavailableIds: string[] = [];
    for (const ad of page.data) {
      const creative = ad.creative as Record<string, unknown> | undefined;
      if (!ids && creative?.type === "chat_card" && !usableImageUrl(creative.image_url, 60_000)) hydrated.push(await readAd(String(ad.id)));
      else hydrated.push(ad);
    }
    const creatives = hydrated.flatMap(ad => {
      const creative = ad.creative as Record<string, unknown> | undefined;
      if (creative?.type !== "chat_card") return [];
      if (!usableImageUrl(creative.image_url)) { unavailableIds.push(String(ad.id)); return []; }
      return [{ id: String(ad.id), name: typeof ad.name === "string" && ad.name.trim() ? ad.name : null, status: ad.status ?? null, review_status: ad.review_status ?? null, file_id: creative.file_id ?? null, image_url: creative.image_url, title: creative.title ?? null, body: creative.body ?? null, target_url: creative.target_url ?? null }];
    });
    return { account_id: a.adAccountId, creatives, hasMore: page.has_more, nextCursor: page.has_more ? page.last_id : null, nativeAdCount: page.data.length, partial: unavailableIds.length > 0, unavailableIds, note: "Signed image links expire. Call again to refresh them. The immutable file_id identifies an uploaded image. Product template ads take their images from the feed and are not listed." };
  });
  register("openai_ads_get_insights", "Read performance by account, campaign, ad group or ad over inclusive account-local dates. One optional country, device or platform breakdown supports delivery metrics only; use openai_ads_get_conversion_insights for conversions by country or device. Attribution defaults to 30-day click, 1-day view and ad_event_time. CTR and CVR are fractions; money uses major units of the account currency. Pages are followed up to maxRows and truncation is explicit.", {
    adAccountId: accountParam,
    since: isoDate.describe("First day of the report, YYYY-MM-DD, in the account's time zone. Inclusive."),
    until: isoDate.describe("Last day of the report, YYYY-MM-DD, in the account's time zone. Inclusive. At most 365 days after since."),
    level: z.enum(OPENAI_ADS_LEVELS).prefault("campaign").describe("Aggregation level: ad_account, campaign, ad_group or ad. Defaults to campaign."),
    metrics: z.array(z.enum(OPENAI_ADS_METRICS)).min(1).max(OPENAI_ADS_METRICS.length).prefault(["spend", "impressions", "clicks"]).describe("Native metrics to return. Defaults to spend, impressions and clicks."),
    timeGranularity: z.enum(["daily", "none"]).prefault("daily").describe("daily returns one row per day; none returns period totals."),
    maxRows: z.number().int().min(1).max(10000).prefault(10000).describe("Maximum rows to collect across pages, 1 to 10,000. truncated is true when more rows exist."),
    breakdown: z.enum(OPENAI_ADS_BREAKDOWNS).optional().describe("One delivery breakdown per request: country, device or platform. Supports impressions, clicks, spend, ctr, cpc and cpm. Omit for entity totals."),
    attribution: openaiAdsAttributionSchema.optional().describe("Report attribution only: attribution_window_days 7, 14 or 30, view_through_attribution_window_days 0 or 1, attribution_time_basis ad_event_time or conversion_time. Campaign goals are unchanged."),
  }, a => client.insights(a as OpenAIAdsReportQuery));

  registerOpenAINative(collector, ctx, false);

  collector.resource?.("openai-ads-guide", "openai-ads://guide", "How this server scopes the account, previews writes and reports units, with the supported metrics, levels and attribution options.", async () => ({
    contents: [{
      uri: "openai-ads://guide", mimeType: "application/json", text: JSON.stringify({
        provider: "ChatGPT Ads",
        access: "One Advertiser API key per ad account. Every tool takes the adAccountId configured in OPENAI_ADS_ACCOUNT_ID, and the first request verifies that the key belongs to it. Writes are registered only with OPENAI_ADS_ENABLE_WRITES=true. Each write previews first and applies only the exact saved preview with confirm:true and its confirmationToken. Creation is always paused. Activation needs OPENAI_ADS_ENABLE_ACTIVATION=true and can spend budget. Nothing is retried automatically. Preview and write receipts live in this process only.",
        metrics: OPENAI_ADS_METRICS, levels: OPENAI_ADS_LEVELS,
        reporting: { breakdowns: OPENAI_ADS_BREAKDOWNS, breakdownMetrics: OPENAI_ADS_DELIVERY_METRICS, attribution: { attribution_window_days: [7, 14, 30], view_through_attribution_window_days: [0, 1], attribution_time_basis: ["ad_event_time", "conversion_time"] }, conversions: "Use openai_ads_get_conversion_insights for conversions by country or device. Platform conversion breakdowns are unavailable." },
        units: { budgetsAndBids: "Integer micros of the account currency (1,000,000 = 1 unit).", reportedMoney: "Major units of the account currency.", feedPrices: "Integer minor units of the price currency (7999 = USD 79.99)." },
        rateLimits: "600 requests per minute per endpoint and 1,200 overall, per ad account and per IP address. Bulk job creation: 10 requests per 10 seconds.",
        notes: OPENAI_ADS_REPORT_NOTES, documentation: OPENAI_ADS_DOCS,
      }),
    }],
  }));
}
