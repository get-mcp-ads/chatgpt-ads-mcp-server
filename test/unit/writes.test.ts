import { afterEach, describe, expect, it, vi } from "vitest";
import { adsBulkBody } from "../../src/bulk.js";
import { adsEditableSnapshot } from "../../src/native-tools.js";
import { OPENAI_ADS_OPERATIONS, adsOperationShape } from "../../src/schema.js";
import { z } from "zod";
import { account, accountId, json, path, setup } from "./harness.js";

const campaign = { name: "Paused acceptance campaign", status: "paused", budget: { lifetime_spend_limit_micros: 1000000 }, bidding_type: "impressions" };
const uuid = () => crypto.randomUUID();
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** A synthetic Advertiser API: entities by path, POST creates or updates, and an optional lost response. */
function api() {
  const entities = new Map<string, any>(), requests: { path: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  let lose = false;
  const fetcher = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const route = path(input).replace("/v1", ""), method = init.method ?? "GET";
    requests.push({ path: route, method, headers: init.headers as Record<string, string>, body: typeof init.body === "string" ? init.body : undefined });
    if (method === "GET") return json(route === "/ad_account" ? account : entities.get(route) ?? {});
    const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
    let data: any;
    if (route === "/campaigns") { data = { ...body, id: "cmpn_123" }; entities.set("/campaigns/cmpn_123", data); }
    else if (/^\/campaigns\/cmpn_[^/]+$/.test(route)) { data = { ...entities.get(route), ...body }; entities.set(route, data); }
    else if (/\/(pause|activate|archive)$/.test(route)) { const target = route.replace(/\/(pause|activate|archive)$/, ""); const status = { pause: "paused", activate: "active", archive: "archived" }[route.split("/").pop()!]; data = { ...entities.get(target), status }; entities.set(target, data); }
    else data = { ok: true };
    if (lose) throw new TypeError("connection reset after the request was sent");
    return json(data);
  });
  vi.stubGlobal("fetch", fetcher);
  return { entities, requests, fetcher, posts: () => requests.filter(r => r.method !== "GET"), loseResponses: () => { lose = true; } };
}

describe("schemas and registration", () => {
  it("builds every pinned operation schema and keeps reads and writes apart", () => {
    for (const op of OPENAI_ADS_OPERATIONS) expect(() => z.object(adsOperationShape(op))).not.toThrow();
    const { tools } = setup();
    expect(tools).toHaveLength(58);
    expect(tools.filter(t => t.write)).toHaveLength(28);
    expect(tools.find(t => t.name === "openai_ads_get_conversion_insights")!.write).toBe(false);
    expect(setup({ enableWrites: false }).tools.some(t => t.write)).toBe(false);
  });
});

describe("preview, confirmation and receipts", () => {
  it("previews without any POST, then applies the exact preview once with the requestId as Idempotency-Key", async () => {
    const f = api(), { call } = setup(), requestId = uuid();
    const { data: preview } = await call("openai_ads_create_campaign", { requestId, body: campaign });
    expect(preview).toMatchObject({ applied: false, change: { body: campaign }, state: "PREVIEW", activationMaySpend: false });
    expect(f.posts()).toHaveLength(0);
    const args = { requestId, body: campaign, confirm: true, confirmationToken: preview.confirmationToken };
    const { data: applied } = await call("openai_ads_create_campaign", args);
    expect(applied).toMatchObject({ applied: true, result: { id: "cmpn_123", status: "paused" }, verification: { confirmed: true } });
    expect(f.posts()).toHaveLength(1);
    expect(f.posts()[0].headers["Idempotency-Key"]).toBe(requestId);
    const { data: again } = await call("openai_ads_create_campaign", args);
    expect(again.replayedReceipt).toBe(true);
    expect(f.posts()).toHaveLength(1);
  });

  it("refuses confirmation without a preview, with changed arguments, and applies a concurrent double confirmation once", async () => {
    const f = api(), { call } = setup(), requestId = uuid();
    expect((await call("openai_ads_create_campaign", { requestId, body: campaign, confirm: true })).data.error.code).toBe("CONFIRMATION_REQUIRED");
    const { data: preview } = await call("openai_ads_create_campaign", { requestId, body: campaign });
    expect((await call("openai_ads_create_campaign", { requestId, body: { ...campaign, name: "Changed" }, confirm: true, confirmationToken: preview.confirmationToken })).data.error.code).toBe("PREVIEW_CHANGED");
    await Promise.all([1, 2].map(() => call("openai_ads_create_campaign", { requestId, body: campaign, confirm: true, confirmationToken: preview.confirmationToken })));
    expect(f.posts()).toHaveLength(1);
  });

  it("refuses a confirmation when the native state changed after the preview", async () => {
    const f = api(), { call } = setup();
    f.entities.set("/campaigns/cmpn_123", { id: "cmpn_123", ...campaign });
    const args = { requestId: uuid(), campaign_id: "cmpn_123", body: { name: "Reviewed rename" } };
    const { data: preview } = await call("openai_ads_update_campaign", args);
    f.entities.get("/campaigns/cmpn_123").name = "Changed by another operator";
    expect((await call("openai_ads_update_campaign", { ...args, confirm: true, confirmationToken: preview.confirmationToken })).data.error.code).toBe("STALE_PREVIEW");
    expect(f.posts()).toHaveLength(0);
  });

  it("never replays a write whose outcome is unknown", async () => {
    const f = api(), { call } = setup(), requestId = uuid();
    const { data: preview } = await call("openai_ads_create_campaign", { requestId, body: campaign });
    f.loseResponses();
    const args = { requestId, body: campaign, confirm: true, confirmationToken: preview.confirmationToken };
    expect((await call("openai_ads_create_campaign", args)).data).toMatchObject({ applied: false, state: "UNKNOWN", reconciliationRequired: true });
    expect((await call("openai_ads_create_campaign", args)).data).toMatchObject({ applied: false, state: "UNKNOWN" });
    expect(f.posts()).toHaveLength(1);
    const { data: receipt } = await call("openai_ads_get_mutation", { mutationId: preview.confirmationToken });
    expect(receipt.state).toBe("UNKNOWN");
  });

  it("keeps a creation receipt and reports incomplete verification when the parent inventory omits the new ad", async () => {
    const ad = { id: "ad_123", name: "Paused ad", status: "paused", creative: { type: "chat_card", title: "Title", body: "Copy", target_url: "https://example.com/", file_id: "file_123" } };
    let indexed = false;
    const fetcher = vi.fn(async (input: unknown, init: RequestInit = {}) => {
      const route = path(input), method = init.method ?? "GET";
      if (route === "/v1/ad_account") return json(account);
      if (route === "/v1/ad_groups/adgrp_parent") return json({ id: "adgrp_parent", status: "paused" });
      if (route === "/v1/ads" && method === "GET") return json({ data: indexed ? [ad] : [], has_more: false });
      return json(ad);
    });
    vi.stubGlobal("fetch", fetcher);
    const { call } = setup();
    const args = { requestId: uuid(), body: { ad_group_id: "adgrp_parent", name: ad.name, status: "paused", creative: ad.creative } };
    const { data: preview } = await call("openai_ads_create_ad", args);
    const confirmed = { ...args, confirm: true, confirmationToken: preview.confirmationToken };
    expect((await call("openai_ads_create_ad", confirmed)).data).toMatchObject({ applied: true, verification: { confirmed: false, parentMembershipConfirmed: false }, reconciliationRequired: true });
    indexed = true;
    expect((await call("openai_ads_create_ad", confirmed)).data).toMatchObject({ replayedReceipt: true, verification: { confirmed: true }, reconciliationRequired: false });
    expect(fetcher.mock.calls.filter(([, init]) => (init as RequestInit).method === "POST")).toHaveLength(1);
  });
});

describe("paused creation and the activation gate", () => {
  it.each(["openai_ads_create_campaign", "openai_ads_update_campaign", "openai_ads_activate_campaign"])("blocks active delivery through %s while activation is disabled", async name => {
    const f = api(), { call } = setup();
    const native = name.includes("create") ? { body: { ...campaign, status: "active" } } : name.includes("update") ? { campaign_id: "cmpn_123", body: { status: "active" } } : { campaign_id: "cmpn_123" };
    const { data } = await call(name, { ...native, requestId: uuid(), confirm: true });
    expect(data.error.code).toMatch(/PAUSED_CREATION_REQUIRED|ACTIVATION_DISABLED/);
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("flags activation as able to spend when it is enabled", async () => {
    const f = api(), { call } = setup({ enableActivation: true });
    f.entities.set("/campaigns/cmpn_123", { id: "cmpn_123", ...campaign });
    const { data: preview } = await call("openai_ads_activate_campaign", { requestId: uuid(), campaign_id: "cmpn_123" });
    expect(preview).toMatchObject({ applied: false, activationMaySpend: true });
    expect(f.posts()).toHaveLength(0);
  });

  it("refuses another account, fractional money, unknown fields and two budgets before networking", async () => {
    const f = api(), { call } = setup();
    expect((await call("openai_ads_create_campaign", { adAccountId: "adacct_other", requestId: uuid(), body: campaign })).data.error.code).toBe("ACCOUNT_NOT_SELECTED");
    for (const body of [{ ...campaign, budget: { lifetime_spend_limit_micros: 1000000.5 } }, { ...campaign, unknown_activation_field: true }]) expect((await call("openai_ads_create_campaign", { requestId: uuid(), body })).data.error.code).toBe("INVALID_INPUT");
    expect((await call("openai_ads_create_campaign", { requestId: uuid(), body: { ...campaign, budget: { daily_spend_limit_micros: 1000000, lifetime_spend_limit_micros: 1000000 } } })).data.error.code).toBe("INVALID_BUDGET");
    expect((await call("openai_ads_create_campaign", { requestId: uuid(), body: { ...campaign, bidding_type: "conversions" } })).data.error.code).toBe("CONVERSION_GOAL_REQUIRED");
    expect((await call("openai_ads_create_ad_group", { requestId: uuid(), body: { campaign_id: "cmpn_123", name: "Automatic group", status: "paused", bidding_config: { billing_event_type: "click", strategy: "maximize_clicks", max_bid_micros: 1000 } } })).data.error.code).toBe("AUTOBID_AMOUNT_FORBIDDEN");
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("refuses every write when writes are disabled, even through the client", async () => {
    const f = api(), { client } = setup({ enableWrites: false });
    await expect(client.native(accountId, "openai_ads_pause_campaign", { campaign_id: "cmpn_123" })).rejects.toMatchObject({ code: "WRITES_DISABLED" });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});

describe("product feed updates", () => {
  const args = () => ({ feed_id: "fd_owned", requestId: uuid(), body: { products: [{ id: "SKU-001", variants: [{ id: "SKU-001", price: { amount: 7999, currency: "USD" } }] }] } });
  it("binds approval to the exact variant fields and blocks a concurrent price edit", async () => {
    let price = "89.00 USD";
    const fetcher = vi.fn(async (input: unknown) => path(input) === "/v1/ad_account" ? json(account) : json({ data: [{ product_id: "SKU-001", item_id: "SKU-001", title: "Shoe", price, availability: "in_stock" }], has_more: false }));
    vi.stubGlobal("fetch", fetcher);
    const { call } = setup(), a = args();
    const { data: preview } = await call("openai_ads_update_feed_products", a);
    expect(preview.before).toEqual({ feedId: "fd_owned", products: [{ productId: "SKU-001", variantId: "SKU-001", price: { amount: 8900, currency: "USD" } }] });
    price = "99.00 USD";
    expect((await call("openai_ads_update_feed_products", { ...a, confirm: true, confirmationToken: preview.confirmationToken })).data.error.code).toBe("STALE_PREVIEW");
    expect(fetcher.mock.calls.some(([, init]) => (init as RequestInit)?.method === "PATCH")).toBe(false);
  });

  it.each([["7999 JPY", 7999, "JPY"], ["7.999 KWD", 7999, "KWD"]])("normalizes the native price %s to that currency's minor units", async (price, amount, currency) => {
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => path(input) === "/v1/ad_account" ? json(account) : json({ data: [{ product_id: "SKU", item_id: "SKU", price }], has_more: false })));
    const { call } = setup();
    const { data } = await call("openai_ads_update_feed_products", { feed_id: "fd_owned", requestId: uuid(), body: { products: [{ id: "SKU", variants: [{ id: "SKU", price: { amount, currency } }] }] } });
    expect(data.before.products[0].price).toEqual({ amount, currency });
  });

  it("refuses an update when the exact native state cannot be established", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => path(input) === "/v1/ad_account" ? json(account) : json({ data: [{ product_id: "other", item_id: "SKU-001", price: "89.00 USD" }], has_more: false })));
    const { call, store } = setup();
    expect((await call("openai_ads_update_feed_products", args())).data.error.code).toBe("PRODUCT_STATE_UNVERIFIABLE");
    expect(store.read("missing")).toBeNull();
  });
});

describe("bulk jobs", () => {
  const operations = [
    { operation_id: "campaign", type: "campaign.create", idempotency_key: "campaign-key", input: { name: "Paused campaign", max_budget_micros: 1000000, billing_event_type: "click" } },
    { operation_id: "group", type: "ad_group.create", idempotency_key: "group-key", input: { campaign_idempotency_key: "campaign-key", name: "Paused group", max_bid_micros: 1000 } },
    { operation_id: "ad", type: "ad.create", idempotency_key: "ad-key", input: { campaign_idempotency_key: "campaign-key", ad_group_idempotency_key: "group-key", title: "Title", body: "Copy", target_url: "https://example.com/", source_image_url: "https://cdn.example.com/card.png" } },
  ];
  it("defaults to validation only and paused creation, and validates dependencies", () => {
    const body = adsBulkBody.parse({ operations });
    expect(body.validate_only).toBe(true);
    expect(body.operations.every(o => o.input.status === "paused")).toBe(true);
    expect(() => adsBulkBody.parse({ operations: [...operations, operations[0]] })).toThrow();
    expect(() => adsBulkBody.parse({ operations: [operations[2]] })).toThrow();
  });

  it("keeps one accepted job receipt and never treats acceptance as verified operations", async () => {
    let posts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init: RequestInit = {}) => {
      if (init.method === "POST") { posts++; return json({ id: "blkmtnjob_123", status: "pending" }, 202); }
      if (path(input).includes("bulk_mutation_jobs")) return json({ id: "blkmtnjob_123", status: "pending" });
      return json(path(input) === "/v1/ad_account" ? account : { id: "cmpn_123", status: "active", name: "Campaign" });
    }));
    const { call } = setup();
    const a = { requestId: uuid(), body: { validate_only: true, partial_failure: false, operations: [{ operation_id: "pause", type: "campaign.update", target_resource_id: "cmpn_123", input: { status: "paused" } }] } };
    const { data: preview } = await call("openai_ads_submit_bulk_job", a);
    const confirmed = { ...a, confirm: true, confirmationToken: preview.confirmationToken };
    expect((await call("openai_ads_submit_bulk_job", confirmed)).data).toMatchObject({ applied: true, jobAccepted: true, operationsVerified: false, nativeValidateOnly: true });
    expect((await call("openai_ads_submit_bulk_job", confirmed)).data).toMatchObject({ replayedReceipt: true });
    expect(posts).toBe(1);
  });

  it("maps a 404 on the bulk endpoint to BULK_NOT_ENABLED", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => path(input) === "/v1/ad_account" ? json(account) : json({ error: { message: "Not found" } }, 404)));
    const { call } = setup({ enableWrites: false });
    expect((await call("openai_ads_get_bulk_job", { jobId: "blkmtnjob_123" })).data.error.code).toBe("BULK_NOT_ENABLED");
  });
});

describe("uploads and renames", () => {
  it("rejects bytes that are not a valid image before uploading", async () => {
    const f = api(), { call } = setup();
    expect((await call("openai_ads_upload_image", { bytesBase64: Buffer.from("not an image").toString("base64"), mimeType: "image/png", filename: "qa.png", requestId: uuid() })).data.error.code).toBe("INVALID_IMAGE");
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("uploads a valid PNG as multipart after confirmation", async () => {
    const png = new Uint8Array(33); png.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82], 0); new DataView(png.buffer).setUint32(16, 800); new DataView(png.buffer).setUint32(20, 800);
    const fetcher = vi.fn(async (input: unknown, init: RequestInit = {}) => path(input) === "/v1/ad_account" ? json(account) : json(init.method === "POST" ? { file_id: "file_123" } : {}));
    vi.stubGlobal("fetch", fetcher);
    const { call } = setup(), a = { bytesBase64: Buffer.from(png).toString("base64"), mimeType: "image/png", filename: "card.png", requestId: uuid() };
    const { data: preview } = await call("openai_ads_upload_image", a);
    expect(preview.change).toMatchObject({ dimensions: { width: 800, height: 800 }, mimeType: "image/png" });
    const { data } = await call("openai_ads_upload_image", { ...a, confirm: true, confirmationToken: preview.confirmationToken });
    expect(data).toMatchObject({ applied: true, result: { file_id: "file_123" } });
    const post = fetcher.mock.calls.find(([, init]) => (init as RequestInit).method === "POST")!;
    expect((post[1] as RequestInit).body).toBeInstanceOf(FormData);
  });

  it.each(["http://cdn.example.com/a.png", "https://user:password@example.com/a.png", "https://127.0.0.1/a.png", "https://localhost/a.png", "https://169.254.169.254/latest", "https://[::1]/a.png", "https://10.0.0.1/a.png", "https://metadata.google.internal/a.png"])("refuses the image URL %s", async imageUrl => {
    const f = api(), { client } = setup();
    await expect(client.uploadImageUrl(accountId, imageUrl)).rejects.toMatchObject({ code: "INVALID_IMAGE_URL" });
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("imports a public image URL without branding fields", async () => {
    const fetcher = vi.fn(async (input: unknown) => path(input) === "/v1/ad_account" ? json(account) : json({ file_id: "file_123" }));
    vi.stubGlobal("fetch", fetcher);
    const { client } = setup();
    await expect(client.uploadImageUrl(accountId, "https://cdn.example.com/approved.png")).resolves.toEqual({ file_id: "file_123" });
    expect(JSON.parse(String((fetcher.mock.calls.at(-1)![1] as RequestInit).body))).toEqual({ image_url: "https://cdn.example.com/approved.png" });
  });

  it("renames by preview then confirmation, and sends nothing when the name is unchanged", async () => {
    const f = api(), { call } = setup();
    f.entities.set("/campaigns/cmpn_123", { id: "cmpn_123", ...campaign });
    const { data: preview } = await call("openai_ads_rename_campaign", { campaignId: "cmpn_123", name: "Spring launch" });
    expect(preview).toMatchObject({ applied: false, action: "openai_ads_rename_campaign", change: { body: { name: "Spring launch" } } });
    expect(f.posts()).toHaveLength(0);
    const { data } = await call("openai_ads_rename_campaign", { campaignId: "cmpn_123", name: "Spring launch", confirm: true });
    expect(data).toMatchObject({ applied: true, verification: { confirmed: true } });
    expect((await call("openai_ads_rename_campaign", { campaignId: "cmpn_123", name: "Spring launch", confirm: true })).data).toMatchObject({ unchanged: true });
    expect(f.posts()).toHaveLength(1);
  });

  it("ignores background review and signed URL rotation in the approval snapshot", () => {
    const first = { id: "ad_123", name: "Reviewed", status: "paused", updated_at: 1, review_status: "in_review", creative: { file_id: "file_123", title: "Approved title", body: "Copy", image_url: "https://cdn.invalid/file_123?sig=first" } };
    const second = { ...first, updated_at: 2, review_status: "approved", creative: { ...first.creative, image_url: "https://cdn.invalid/file_123?sig=rotated" } };
    expect(adsEditableSnapshot(first)).toEqual(adsEditableSnapshot(second));
    expect(adsEditableSnapshot(first)).not.toEqual(adsEditableSnapshot({ ...second, name: "Changed" }));
  });
});
