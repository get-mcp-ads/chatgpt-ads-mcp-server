import { afterEach, describe, expect, it, vi } from "vitest";
import { account, json, path, setup } from "./harness.js";

const signed = (expiry: string) => "https://sdmntprsouthcentralus.oaiusercontent.com/files/file_test/raw?se=" + encodeURIComponent(expiry) + "&sig=synthetic";
const ad = (id: string, image?: string) => ({ id, name: id, status: "paused", creative: { type: "chat_card", file_id: "file_" + id, title: "Title", body: "Copy", target_url: "https://example.com/", ...(image ? { image_url: image } : {}) } });
function stub(handler: (route: string) => unknown) {
  const fetcher = vi.fn(async (input: unknown) => path(input) === "/v1/ad_account" ? json(account) : json(handler(path(input))));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
const routes = (fetcher: ReturnType<typeof vi.fn>) => fetcher.mock.calls.map(([u]) => path(u)).filter(p => p !== "/v1/ad_account");
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("openai_ads_list_ad_creatives", () => {
  it("refreshes an expired signed image link with one exact ad read", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-21T13:00:00Z"));
    const fresh = signed("2026-10-21T13:20:00Z");
    const fetcher = stub(route => route === "/v1/ads" ? { data: [ad("ad_test", signed("2026-10-21T12:59:00Z"))], has_more: false } : ad("ad_test", fresh));
    const { data } = await setup({ enableWrites: false }).call("openai_ads_list_ad_creatives", {});
    expect(data).toMatchObject({ creatives: [{ id: "ad_test", image_url: fresh, file_id: "file_ad_test", target_url: "https://example.com/" }], partial: false, nativeAdCount: 1 });
    expect(routes(fetcher)).toEqual(["/v1/ads", "/v1/ads/ad_test"]);
  });

  it("keeps fresh links without extra reads and reports links still expired as unavailable", async () => {
    let fetcher = stub(() => ({ data: [ad("ad_fresh", signed("2030-01-01T00:00:00Z"))], has_more: false }));
    expect((await setup({ enableWrites: false }).call("openai_ads_list_ad_creatives", {})).data.creatives).toHaveLength(1);
    expect(routes(fetcher)).toEqual(["/v1/ads"]);
    const expired = signed("2020-01-01T00:00:00Z");
    fetcher = stub(route => route === "/v1/ads" ? { data: [ad("ad_old", expired)], has_more: false } : ad("ad_old", expired));
    expect((await setup({ enableWrites: false }).call("openai_ads_list_ad_creatives", {})).data).toMatchObject({ creatives: [], partial: true, unavailableIds: ["ad_old"] });
  });

  it("reads exact ad IDs once each and refuses a readback of another ad", async () => {
    let fetcher = stub(route => ad(route.split("/").at(-1)!, signed("2030-01-01T00:00:00Z")));
    const { data } = await setup({ enableWrites: false }).call("openai_ads_list_ad_creatives", { adIds: ["ad_one", "ad_two", "ad_one"] });
    expect(data.creatives.map((c: { id: string }) => c.id)).toEqual(["ad_one", "ad_two"]);
    expect(routes(fetcher)).toEqual(["/v1/ads/ad_one", "/v1/ads/ad_two"]);
    fetcher = stub(() => ad("ad_other", signed("2030-01-01T00:00:00Z")));
    const { result, data: refused } = await setup({ enableWrites: false }).call("openai_ads_list_ad_creatives", { adIds: ["ad_selected"] });
    expect(result.isError).toBe(true);
    expect(refused.error.code).toBe("INVALID_RESPONSE");
    expect(JSON.stringify(refused)).not.toContain("ad_other");
  });
});
