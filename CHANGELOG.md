# Changelog

## 1.0.1 - 2026-10-26 - Zod 4 security update
- Update `zod` to 4.6.7. Every Zod release before 4.6.6 is covered by the high-severity advisory GHSA-mrhx-c7xc-m3w5: validating an oversized constrained collection can exhaust memory, and no Zod 3 release carries the fix. `npm audit --omit=dev` reports no vulnerability again.
- Keep the Zod 3 validation behaviour. A parameter default is still validated and completed before use, so an omitted object must still supply its required fields.
- Keep each parameter's own description when the parameter is optional or has a default. Zod 4 stores a description on the wrapped schema only, so the shared fallback description could otherwise replace it.
- Tool names, parameters and descriptions published over MCP are unchanged. `server-card.json` is regenerated with Zod 4's JSON Schema output, which spells some constraints differently.

## 1.0.0 - 2026-10-23 - First standalone release
- Create the first standalone server for the ChatGPT Ads Advertiser API, ported from the hosted getmcpads gateway at revision 3e1c2c8.
- Expose 30 read tools, 28 write tools that are disabled by default, and one guide resource.
- Read the account, campaigns, ad groups, ads, chat card creatives, performance insights with country, device and platform breakdowns, conversion setup and insights, product feeds, custom audiences, audit logs, spend limits and Bulk API jobs.
- Pin the native request schemas to the public OpenAPI document (sha256 `266e7e19`), with a generator that refreshes them from a saved copy.
- Scope every call to the account in `OPENAI_ADS_ACCOUNT_ID` and verify on the first request that the API key belongs to it.
- Preview every write and apply only the exact saved preview after confirmation. Creations are paused, activation needs its own flag, and nothing is retried automatically.
- Send requests only to `api.ads.openai.com`, refuse redirects, bound response size and time, and redact the key from provider text.
- Require Node.js 22.23.4, 24.22.1, 26.12.1 or newer within each line, and warn on stderr when the runtime lacks the October 2026 security fixes.
