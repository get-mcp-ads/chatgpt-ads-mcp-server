import { vi } from "vitest";
import { OpenAIAdsClient, OpenAIAdsError } from "../../src/client.js";
import { MemoryMutationStore, OpenAIAdsMutations } from "../../src/mutations.js";
import { registerOpenAIAdsReads } from "../../src/tools.js";
import { registerOpenAINative } from "../../src/native-tools.js";
import type { ToolContext } from "../../src/context.js";

export const accountId = "adacct_test123";
export const apiKey = "synthetic-advertiser-api-key-0123456789";
export const account = { id: accountId, name: "Synthetic advertiser", currency_code: "EUR", timezone: "Europe/Paris", status: "active", review: { status: "approved" } };
export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
export const page = (data: Record<string, unknown>[], more = false, last = "cursor") => ({ data, has_more: more, last_id: last });
export const path = (url: unknown) => new URL(String(url)).pathname;

export type Options = { enableWrites?: boolean; enableActivation?: boolean };
export function setup(options: Options = {}) {
  const config = { apiKey, accountId, enableWrites: options.enableWrites ?? true, enableActivation: options.enableActivation ?? false };
  const client = new OpenAIAdsClient(config);
  const store = new MemoryMutationStore();
  const mutations = new OpenAIAdsMutations({ store, authorize: (id, apply) => { client.scope(id); if (apply && !config.enableWrites) throw new OpenAIAdsError(403, "WRITES_DISABLED", "disabled"); } });
  const ctx: ToolContext = { client, mutations, secret: apiKey };
  const tools: { name: string; description: string; shape: Record<string, unknown>; handler: (a: Record<string, unknown>) => Promise<any>; write: boolean }[] = [];
  const collector = { tool(name: string, description: string, shape: any, handler: any) { tools.push({ name, description, shape, handler, write: Object.hasOwn(shape, "confirm") }); }, resource() {} };
  registerOpenAIAdsReads(collector, ctx);
  if (config.enableWrites) registerOpenAINative(collector, ctx, true);
  const tool = (name: string) => { const t = tools.find(t => t.name === name); if (!t) throw new Error(`No tool ${name}`); return t; };
  const call = async (name: string, args: Record<string, unknown>) => { const r = await tool(name).handler({ adAccountId: accountId, ...args }); return { result: r, data: JSON.parse(r.content[0].text) }; };
  return { config, client, store, mutations, tools, tool, call };
}

/** A fetch stub that answers the onboarding account read and delegates everything else. */
export function stubFetch(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const fetcher = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/ad_account" && (init.method ?? "GET") === "GET") return json(account);
    return handler(url, init);
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
export const nonAccountCalls = (fetcher: ReturnType<typeof vi.fn>) => fetcher.mock.calls.filter(([u]) => path(u) !== "/v1/ad_account");
