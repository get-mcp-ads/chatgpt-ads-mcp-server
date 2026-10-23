import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIAdsClient, OPENAI_ADS_BREAKDOWNS, openaiAdsAttributionSchema, type OpenAIAdsAttributionInput, type OpenAIAdsReportQuery } from "../../src/client.js";
import { accountId, apiKey, json, path, setup, stubFetch } from "./harness.js";

const config = { apiKey, accountId, enableWrites: false, enableActivation: false };
const query: OpenAIAdsReportQuery = { adAccountId: accountId, since: "2026-10-14", until: "2026-10-15", level: "campaign", metrics: ["spend", "ctr"], timeGranularity: "daily" };
const rows = (data: Record<string, unknown>[], has_more = false, last_id = "next") => json({ data, has_more, last_id });
const insightCalls = (fetcher: ReturnType<typeof vi.fn>) => fetcher.mock.calls.filter(([u]) => path(u) === "/v1/ad_account/insights").map(([u]) => new URL(String(u)));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("segmented delivery", () => {
  it.each([
    { breakdown: "country" as const, dimension: "country_name", value: "France", field: "country.name" },
    { breakdown: "device" as const, dimension: "device_type", value: "mobile", field: "device.type" },
    { breakdown: "platform" as const, dimension: "platform", value: "web", field: "platform" },
  ])("uses $breakdown values rather than repeated campaign totals", async ({ breakdown, dimension, value, field }) => {
    const fetcher = stubFetch(() => rows([{ [dimension]: value, campaign_id: "cmpn_1", spend: 999, ctr: 0.9, [`${breakdown}_spend`]: 12.5, [`${breakdown}_ctr`]: 0.04 }]));
    const r = await new OpenAIAdsClient(config).insights({ ...query, breakdown });
    expect(r.rows[0]).toMatchObject({ [breakdown]: value, spend: 12.5, ctr: 0.04 });
    const params = insightCalls(fetcher)[0].searchParams;
    expect(params.getAll("segments[]")).toEqual([breakdown]);
    expect(params.getAll("fields[]")).toEqual(["campaign.id", "campaign.name", "metadata.readable_time", field, `${breakdown}.spend`, `${breakdown}.ctr`]);
  });

  it("keeps null metrics and the unknown-country bucket", async () => {
    stubFetch(() => rows([{ country_name: null, spend: 900, country_spend: null }]));
    expect((await new OpenAIAdsClient(config).insights({ ...query, breakdown: "country" })).rows[0]).toMatchObject({ country: null, spend: null, ctr: null });
  });

  it("fails when the provider omits the requested dimension", async () => {
    stubFetch(() => rows([{ spend: 900, campaign_id: "cmpn_1" }]));
    await expect(new OpenAIAdsClient(config).insights({ ...query, breakdown: "country" })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it.each(OPENAI_ADS_BREAKDOWNS)("rejects conversions in a %s delivery report before any network call", async breakdown => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const { call } = setup({ enableWrites: false });
    const { result, data } = await call("openai_ads_get_insights", { since: query.since, until: query.until, breakdown, metrics: ["spend", "conversions"] });
    expect(result.isError).toBe(true);
    expect(data.error).toMatchObject({ code: "UNSUPPORTED_BREAKDOWN_METRICS", status: 400, recoverable: true });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps segmentation and attribution unchanged on later pages", async () => {
    let n = 0;
    const fetcher = stubFetch(() => n++ === 0 ? rows([{ country_name: "France", country_spend: 10 }], true, "second") : rows([{ country_name: "Canada", country_spend: 20 }]));
    const r = await new OpenAIAdsClient(config).insights({ ...query, metrics: ["spend"], breakdown: "country", attribution: { attribution_window_days: 7, view_through_attribution_window_days: 0, attribution_time_basis: "conversion_time" } });
    expect(r.rows.map(row => row.spend)).toEqual([10, 20]);
    const [first, second] = insightCalls(fetcher);
    expect(second.searchParams.get("after")).toBe("second");
    second.searchParams.delete("after");
    expect(second.searchParams.toString()).toBe(first.searchParams.toString());
  });
});

describe("report attribution", () => {
  const combinations = [7, 14, 30].flatMap(click => [0, 1].flatMap(view => ["ad_event_time", "conversion_time"].map(basis => [click, view, basis] as const)));
  it.each(combinations)("passes %i click days, %i view days and %s", async (click, view, basis) => {
    const fetcher = stubFetch(() => rows([]));
    const selected = { attribution_window_days: click, view_through_attribution_window_days: view, attribution_time_basis: basis } as OpenAIAdsAttributionInput;
    const r = await new OpenAIAdsClient(config).insights({ ...query, metrics: ["conversions", "order_created_roas"], attribution: selected });
    const params = insightCalls(fetcher)[0].searchParams;
    for (const [key, value] of Object.entries(selected)) expect(params.get(key)).toBe(String(value));
    expect(r.attributionSettings).toEqual(selected);
    expect(r.attribution).toContain(basis === "conversion_time" ? "conversion date" : "ad interaction date");
  });

  it("defaults omitted attribution fields independently", async () => {
    expect(openaiAdsAttributionSchema.parse({ view_through_attribution_window_days: 0 })).toEqual({ attribution_window_days: 30, view_through_attribution_window_days: 0, attribution_time_basis: "ad_event_time" });
    stubFetch(() => rows([]));
    expect((await new OpenAIAdsClient(config).insights(query)).attributionSettings).toEqual({ attribution_window_days: 30, view_through_attribution_window_days: 1, attribution_time_basis: "ad_event_time" });
  });

  it.each([{ attribution_window_days: 1 }, { view_through_attribution_window_days: 7 }, { attribution_time_basis: "utc" }, { unknown: true }])("rejects unsupported attribution %j before networking", async invalid => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(new OpenAIAdsClient(config).insights({ ...query, attribution: invalid as OpenAIAdsAttributionInput })).rejects.toMatchObject({ code: "INVALID_ATTRIBUTION" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("native read operations", () => {
  it("brackets native query arrays and keeps conversion insights a read", async () => {
    const fetcher = stubFetch(() => json({ data: [], has_more: false }));
    const { call, tool } = setup({ enableWrites: false });
    await call("openai_ads_get_feeds", { query: { include: ["product_count"], limit: 10 } });
    await call("openai_ads_get_conversion_insights", { body: { aggregation_level: "campaign", time_ranges: [JSON.stringify({ type: "date_range", since: "2026-10-01", until: "2026-10-07" })], breakdown: "country" } });
    expect(tool("openai_ads_get_conversion_insights").write).toBe(false);
    const [feeds, conversions] = fetcher.mock.calls.filter(([u]) => path(u) !== "/v1/ad_account");
    expect(new URL(String(feeds[0])).searchParams.getAll("include[]")).toEqual(["product_count"]);
    expect((conversions[1] as RequestInit).method).toBe("POST");
    expect(JSON.parse(String((conversions[1] as RequestInit).body))).toMatchObject({ aggregation_level: "campaign", breakdown: "country" });
  });

  it("rejects path traversal in native identifiers before networking", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const { call } = setup({ enableWrites: false });
    const { data } = await call("openai_ads_get_feed_settings", { feed_id: "../../ad_account" });
    expect(data.error.code).toBe("INVALID_INPUT");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
