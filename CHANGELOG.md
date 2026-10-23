# Changelog

## 1.0.0 - 2026-10-23 - First standalone release
- Create the first standalone server for the ChatGPT Ads Advertiser API, ported from the hosted getmcpads gateway at revision 3e1c2c8.
- Expose 30 read tools, 28 write tools that are disabled by default, and one guide resource.
- Read the account, campaigns, ad groups, ads, chat card creatives, performance insights with country, device and platform breakdowns, conversion setup and insights, product feeds, custom audiences, audit logs, spend limits and Bulk API jobs.
- Pin the native request schemas to the public OpenAPI document (sha256 `266e7e19`), with a generator that refreshes them from a saved copy.
- Scope every call to the account in `OPENAI_ADS_ACCOUNT_ID` and verify on the first request that the API key belongs to it.
- Preview every write and apply only the exact saved preview after confirmation. Creations are paused, activation needs its own flag, and nothing is retried automatically.
- Send requests only to `api.ads.openai.com`, refuse redirects, bound response size and time, and redact the key from provider text.
- Require Node.js 22.23.4, 24.22.1, 26.12.1 or newer within each line, and warn on stderr when the runtime lacks the October 2026 security fixes.
