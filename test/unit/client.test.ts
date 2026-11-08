import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIAdsClient } from "../../src/client.js";
import { account, accountId, apiKey, json, page, path, setup, stubFetch } from "./harness.js";

const config = { apiKey, accountId, enableWrites: false, enableActivation: false };
const query = { adAccountId: accountId, since: "2026-09-01", until: "2026-09-07", level: "campaign" as const, metrics: ["spend", "impressions", "clicks", "ctr"] as ("spend" | "impressions" | "clicks" | "ctr")[], timeGranularity: "daily" as const };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("account allowlist and key verification", () => {
  it("reads the account with one GET to the fixed host, no redirect following and a bearer key", async () => {
    const fetcher = vi.fn(async () => json(account)); vi.stubGlobal("fetch", fetcher);
    expect(await new OpenAIAdsClient(config).account(accountId)).toEqual(account);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.ads.openai.com/v1/ad_account");
    expect(init).toMatchObject({ method: "GET", redirect: "error", headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each(["adacct_other", "123", "../ad_account"])("refuses %s before any network call", async id => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const { call } = setup({ enableWrites: false });
    const { result, data } = await call("openai_ads_get_campaigns", { adAccountId: id });
    expect(result.isError).toBe(true);
    expect(["ACCOUNT_NOT_SELECTED", "INVALID_INPUT"]).toContain(data.error.code);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("verifies once that the key belongs to the configured account, then reuses it", async () => {
    const fetcher = stubFetch(() => json(page([])));
    const client = new OpenAIAdsClient(config);
    await client.list(accountId, "campaigns");
    await client.list(accountId, "campaigns");
    expect(fetcher.mock.calls.map(([u]) => path(u))).toEqual(["/v1/ad_account", "/v1/campaigns", "/v1/campaigns"]);
  });

  it("refuses a key that belongs to another account and sends nothing else", async () => {
    const fetcher = vi.fn(async () => json({ ...account, id: "adacct_someone_else" })); vi.stubGlobal("fetch", fetcher);
    await expect(new OpenAIAdsClient(config).list(accountId, "campaigns")).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe("provider error mapping and redaction", () => {
  it.each([[401, "AUTHENTICATION_FAILED"], [403, "ACCESS_DENIED"], [404, "NOT_FOUND"], [429, "RATE_LIMITED"], [503, "PROVIDER_ERROR"]])("makes one attempt for HTTP %i and maps it to %s", async (status, code) => {
    const fetcher = stubFetch(() => json({ error: { message: `bad key ${apiKey}` } }, status, { "x-request-id": "req_123" }));
    const error = await new OpenAIAdsClient(config).list(accountId, "campaigns").catch(e => e);
    expect(error).toMatchObject({ status, code, retryable: false, requestId: "req_123" });
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain(apiKey);
    expect(fetcher.mock.calls.filter(([u]) => path(u) === "/v1/campaigns")).toHaveLength(1);
  });

  it("returns redacted native validation text for 400 errors only", async () => {
    stubFetch(() => json({ error: { message: `Invalid field name; Authorization: Bearer ${apiKey}` } }, 400));
    const { call } = setup({ enableWrites: false });
    const { result, data } = await call("openai_ads_get_campaigns", {});
    expect(result.isError).toBe(true);
    expect(data.error).toMatchObject({ code: "NATIVE_VALIDATION_FAILED", status: 400, recoverable: true, retryable: false });
    expect(data.error.nativeMessage).toContain("Invalid field name");
    expect(JSON.stringify(data)).not.toContain(apiKey);
  });

  it("stops on a Cloudflare 1010 block without retry and without echoing the body", async () => {
    const fetcher = stubFetch(() => json({ error_code: 1010, error_name: "browser_signature_banned", detail: apiKey }, 403, { "cf-ray": "synthetic-CDG" }));
    const { call } = setup({ enableWrites: false });
    const { data } = await call("openai_ads_get_campaigns", {});
    expect(data.error).toMatchObject({ code: "CLOUDFLARE_BLOCKED", requestId: "synthetic-CDG", retryable: false, recoverable: false });
    expect(JSON.stringify(data)).not.toContain(apiKey);
    expect(fetcher.mock.calls.filter(([u]) => path(u) === "/v1/campaigns")).toHaveLength(1);
  });

  it("treats an HTTP 200 carrying an error object as an error, not as data", async () => {
    stubFetch(() => json({ error: { message: "Something failed" } }));
    await expect(new OpenAIAdsClient(config).list(accountId, "campaigns")).rejects.toMatchObject({ code: "PROVIDER_ERROR", status: 502, nativeMessage: "Something failed" });
  });

  it("surfaces the native minimum daily budget as a structured constraint", async () => {
    stubFetch(() => json({ error: { message: "400: Daily campaign budget must be at least 5000000 micros." } }, 400));
    await expect(new OpenAIAdsClient(config).list(accountId, "campaigns")).rejects.toMatchObject({ details: { field: "budget.daily_spend_limit_micros", minimum: 5000000, unit: "micros" } });
  });

  it("refuses a redirect response and never reads its Location", async () => {
    const fetcher = stubFetch(() => new Response(null, { status: 302, headers: { Location: `https://untrusted.invalid/?key=${apiKey}` } }));
    const error = await new OpenAIAdsClient(config).list(accountId, "campaigns").catch(e => e);
    expect(error).toMatchObject({ code: "REDIRECT_REFUSED", status: 302 });
    expect(error.message).not.toContain("untrusted.invalid");
    expect(fetcher.mock.calls.every(([, init]) => (init as RequestInit).redirect === "error")).toBe(true);
  });

  it("maps a fetch-level redirect refusal and a transport failure without retrying", async () => {
    const redirect = Object.assign(new TypeError("fetch failed"), { cause: new Error("unexpected redirect") });
    let fail: Error = redirect;
    const fetcher = stubFetch(() => { throw fail; });
    await expect(new OpenAIAdsClient(config).list(accountId, "campaigns")).rejects.toMatchObject({ code: "REDIRECT_REFUSED" });
    fail = new TypeError(`network down ${apiKey}`);
    const error = await new OpenAIAdsClient(config).list(accountId, "campaigns").catch(e => e);
    expect(error).toMatchObject({ code: "TRANSPORT_ERROR" });
    expect(error.message).not.toContain(apiKey);
    expect(fetcher.mock.calls.filter(([u]) => path(u) === "/v1/campaigns")).toHaveLength(2);
  });

  it("refuses an oversized response instead of truncating it", async () => {
    stubFetch(() => new Response("x".repeat(9 * 1024 * 1024)));
    await expect(new OpenAIAdsClient(config).list(accountId, "campaigns")).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  });
});

describe("pagination", () => {
  it("returns one list page with its native cursor and query", async () => {
    const fetcher = stubFetch(() => json(page([{ id: "cmpn_1" }], true, "cmpn_1")));
    const { call } = setup({ enableWrites: false });
    const { data } = await call("openai_ads_get_ad_groups", { campaignId: "cmpn_1", limit: 50, after: "adgrp_0", include: ["serving_issues"] });
    expect(data).toMatchObject({ has_more: true, last_id: "cmpn_1" });
    const url = new URL(String(fetcher.mock.calls.at(-1)![0]));
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ limit: "50", order: "desc", campaign_id: "cmpn_1", after: "adgrp_0" });
    expect(url.searchParams.getAll("include[]")).toEqual(["serving_issues"]);
  });

  it("rejects a page that claims more results without a cursor", async () => {
    stubFetch(() => json({ data: [], has_more: true }));
    await expect(new OpenAIAdsClient(config).list(accountId, "campaigns")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("follows insights pages with last_id and keeps dates, fractions and nulls", async () => {
    let n = 0;
    const fetcher = stubFetch(() => json(n++ === 0 ? page([{ campaign_id: "cmpn_1", spend: 12.5, ctr: 0.04 }], true, "next") : page([{ campaign_id: "cmpn_2", spend: null, ctr: null }])));
    const result = await new OpenAIAdsClient(config).insights(query);
    expect(result).toMatchObject({ truncated: false, rows: [{ spend: 12.5, ctr: 0.04 }, { spend: null, ctr: null }] });
    const [first, second] = fetcher.mock.calls.filter(([u]) => path(u) === "/v1/ad_account/insights").map(([u]) => new URL(String(u)));
    expect(JSON.parse(first.searchParams.get("time_ranges[]")!)).toEqual({ type: "date_range", since: query.since, until: query.until });
    expect(first.searchParams.getAll("fields[]")).toContain("campaign.spend");
    expect(first.searchParams.get("attribution_window_days")).toBe("30");
    expect(second.searchParams.get("after")).toBe("next");
  });

  it("reports truncation instead of presenting a partial result as complete", async () => {
    stubFetch(() => json(page([{ spend: 1 }], true)));
    expect(await new OpenAIAdsClient(config).insights({ ...query, maxRows: 1 })).toMatchObject({ truncated: true, rows: [{ spend: 1 }] });
  });

  it("stops on a repeated cursor", async () => {
    stubFetch(() => json(page([{ spend: 1 }], true, "repeated")));
    await expect(new OpenAIAdsClient(config).insights(query)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("rejects impossible dates before any network call", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(new OpenAIAdsClient(config).insights({ ...query, since: "2026-02-31" })).rejects.toMatchObject({ code: "INVALID_DATES" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
