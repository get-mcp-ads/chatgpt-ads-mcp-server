<div align="center">

# ChatGPT Ads MCP server

### Bring your ChatGPT Ads account into your MCP client.

Read campaigns, performance and conversions, and prepare changes for the ad account your API key belongs to.

[![Release](https://img.shields.io/github/v/release/get-mcp-ads/chatgpt-ads-mcp-server?color=2448e5)](https://github.com/get-mcp-ads/chatgpt-ads-mcp-server/releases/latest)
[![CI](https://github.com/get-mcp-ads/chatgpt-ads-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/get-mcp-ads/chatgpt-ads-mcp-server/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-22.23.4%20%7C%2024.22.1%20%7C%2026.12.1-brightgreen.svg)](package.json)

[Watch the film](https://www.getmcpads.com/home/film/get-mcp-ads-brand-film-1080p.mp4) · [What's new](#whats-new) · [Install](#install-this-release) · [Tool reference](#tools) · [Try hosted getmcpads](https://www.getmcpads.com/tools/chatgpt-ads?utm_source=github&utm_medium=readme&utm_campaign=chatgpt-ads)

[![Watch the getmcpads film: every ad account in one conversation with your AI assistant](https://www.getmcpads.com/home/film/brand-film-poster-promise.webp)](https://www.getmcpads.com/home/film/get-mcp-ads-brand-film-1080p.mp4)

**[Play the 45-second film](https://www.getmcpads.com/home/film/get-mcp-ads-brand-film-1080p.mp4)**

</div>

The film shows hosted getmcpads with sample data. Its MCP Apps, from creative galleries and alerts to Google Sheets exports and bulk launches, belong to the hosted product. This repository provides the standalone native API tools.

**30 read tools** · **28 write tools**, disabled by default.

Run locally with your own Advertiser API key and a client that supports stdio MCP, such as Claude Desktop, Claude Code or Cursor. Your requests go directly to the ChatGPT Ads API. For managed connections, including supported ChatGPT setups, use the hosted option.

## What's new

**[v1.0.0: First standalone release](https://github.com/get-mcp-ads/chatgpt-ads-mcp-server/releases/tag/v1.0.0) · October 23, 2026**

- Port the 58 ChatGPT Ads tools of the hosted gateway: account, campaigns, ad groups, ads, creatives, insights, conversions, product feeds, custom audiences, audit logs, spend limits and Bulk API jobs.
- Pin the native request schemas to OpenAI's public OpenAPI document and validate every request against them before it is sent.
- Scope every call to one configured ad account and verify that the API key belongs to it.
- Preview every write and apply only the approved preview. Creations are paused and activation has its own switch.
- Send requests only to `api.ads.openai.com`, refuse redirects and never retry automatically.

[Full changelog](CHANGELOG.md) · [Source synchronization details](SOURCE_SYNC.md) · [All releases](https://github.com/get-mcp-ads/chatgpt-ads-mcp-server/releases)

### Upgrade notes

Requires **Node.js 22.23.4 or later on the 22 line, 24.22.1 or later on the 24 line, or 26.12.1 or later**. These releases carry the October 2026 security fixes, and the server prints a warning on stderr when started on an older runtime. CI covers Node 22, 24 and 26. Writes remain optional and require explicit confirmation. Hosted creative integrations and MCP Apps UI are outside this release.

## Install this release

This is a GitHub source release. npm and MCP Registry versions are published separately. The commands below select this exact version; unpinned `npx` examples later in this document select the version currently available on npm.

```bash
git clone --branch v1.0.0 --depth 1 https://github.com/get-mcp-ads/chatgpt-ads-mcp-server.git
cd chatgpt-ads-mcp-server
npm ci
npm run build
```

Configure your MCP client to run `node` with the absolute path to `dist/cli.js` and the environment variables documented below. With the npm package, a client configuration looks like this:

```json
{
  "mcpServers": {
    "chatgpt-ads": {
      "command": "npx",
      "args": ["-y", "@getmcpads/chatgpt-ads-mcp-server"],
      "env": {
        "OPENAI_ADS_API_KEY": "your-advertiser-api-key",
        "OPENAI_ADS_ACCOUNT_ID": "adacct_your_account"
      }
    }
  }
}
```

Run `npm run doctor` to check the configuration without contacting ChatGPT Ads, then call `openai_ads_get_account` first.

> **Managed connection.** [Use ChatGPT Ads with hosted getmcpads](https://www.getmcpads.com/tools/chatgpt-ads?utm_source=github&utm_medium=readme&utm_campaign=chatgpt-ads). Connect your account, select the data your assistant may access and use the hosted MCP connection. See the site for current features and plans.

## Configuration

Provide these environment variables through the client's secret configuration:

| Variable | Purpose |
|---|---|
| `OPENAI_ADS_API_KEY` | Required. An Advertiser API key created on the Settings page of [Ads Manager](https://ads.openai.com/). Each key is scoped to one ad account. This is not an OpenAI Platform API key. |
| `OPENAI_ADS_ACCOUNT_ID` | Required. The `adacct_` ID of the account the key belongs to. Every other account ID is refused, and the first request checks that the key matches. |
| `OPENAI_ADS_ENABLE_WRITES` | Defaults to `false`. Only the exact value `true` registers the write tools. |
| `OPENAI_ADS_ENABLE_ACTIVATION` | Defaults to `false`. `true` allows activation and changes to `status: "active"`, which can start delivery and spend budget. Requires writes. |

You need an ad account in Ads Manager and an Advertiser API key, as described in [OpenAI's Advertiser API overview](https://developers.openai.com/ads/api-overview). Some features are enabled per account: the [Bulk API](https://developers.openai.com/ads/bulk-api) is in limited preview, and API partners need pixel management and conversion-optimized bidding enabled for each client account, as described in [API Partner Setup](https://developers.openai.com/ads/api-partner-setup). The server returns the native access error when a feature is not enabled. API use is governed by OpenAI's [Advertising Terms](https://openai.com/policies/advertising-terms/), which require you to keep API keys confidential.

This package reads a key from the environment. It runs no browser sign-in and writes nothing to disk. To rotate the key, create a new one in Ads Manager, update the variable and restart the server.

## Safety and coverage

Writes preview by default. A call without `confirm` returns the change, the native state it was checked against and a `confirmationToken`. After the person approves the exact preview, repeat the identical call with `confirm: true` and that token. Use one `requestId` UUID per logical change; creations send it as the native `Idempotency-Key`, which OpenAI uses to avoid creating a duplicate when the same creation is sent again.
Before applying, the server reads the native state again and refuses the write if it changed since the preview. After applying, it reads campaigns, ad groups, ads and feed products back and reports whether the change is confirmed.
Campaigns, ad groups and ads are created paused. Activation is refused unless `OPENAI_ADS_ENABLE_ACTIVATION=true`, and previews that can start delivery carry `activationMaySpend: true`.
A write whose outcome is uncertain is recorded as `UNKNOWN` and never resubmitted. Read the receipt with `openai_ads_get_mutation` and the native state before deciding anything else. Previews and receipts live in memory and a restart forgets them.
Account checks run before every request. Unknown arguments are rejected, and nested request bodies are validated against the pinned native schemas.

Requests go only to `api.ads.openai.com` with a 30 second timeout and an 8 MiB response bound. Redirects are refused. The key is removed from any provider text, and only validation errors return native messages. The API allows 600 requests per minute per endpoint and 1,200 overall; a throttled request returns `RATE_LIMITED` without a retry.
Budgets and bids use integer micros of the account currency (1,000,000 is one unit). Reported spend, CPC and CPM use major units, CTR and conversion rates are fractions, and missing values stay `null`. Product feed prices use minor units (7999 is USD 79.99).

This server exposes a reviewed subset of the API. It leaves out API key provisioning, billing and spend limit changes, account administration, partner account creation, custom audience creation and membership uploads, lead sync webhooks and SFTP credentials. New upstream endpoints are not exposed automatically.
Use `tools/list` or [server-card.json](server-card.json) for exact schemas, `openai_ads_get_write_schema` for nested request fields, and [the official API reference](https://developers.openai.com/ads/api-reference) for provider details.

## Hosted option

[getmcpads for ChatGPT Ads](https://www.getmcpads.com/tools/chatgpt-ads) manages the hosted connection and account selection.
Hosted and source releases can differ. Contact: hello@getmcpads.com.

## Development

```bash
npm run typecheck
npm run lint
npm run build
npm test
npm run catalog
```

All tests run offline with synthetic responses. No live account is read or changed. To refresh the pinned schemas, save the official OpenAPI document and run `node scripts/generate-contracts.mjs <path> <date>`.

## Tools

Every tool is listed below. See [server-card.json](server-card.json) for complete parameter and output schemas. Every tool takes `adAccountId`, the account in `OPENAI_ADS_ACCOUNT_ID`.

<details>
<summary><b>30 read tools</b></summary>

| Tool | Purpose |
| --- | --- |
| `openai_ads_get_account` | Read the account's name, currency, time zone, status and brand review, and verify that the key belongs to it. |
| `openai_ads_get_campaigns` | List one page of campaigns. |
| `openai_ads_get_campaign` | Read one campaign with its budget, schedule and targeting. |
| `openai_ads_get_ad_groups` | List one page of the ad groups of a campaign. |
| `openai_ads_get_ad_group` | Read one ad group with its bidding, context hints and product set. |
| `openai_ads_get_ads` | List one page of the ads of an ad group, with creative metadata and review status. |
| `openai_ads_get_ad` | Read one ad with its creative and review status. |
| `openai_ads_list_ad_creatives` | List chat card creatives with their file IDs and signed image links, refreshing expired links. |
| `openai_ads_get_insights` | Read performance by account, campaign, ad group or ad, with one optional country, device or platform breakdown and attribution settings. |
| `openai_ads_search_locations` | Search country, region and market location IDs for geographic targeting. |
| `openai_ads_get_audit_logs` | List recorded changes to campaigns, ad groups and ads. |
| `openai_ads_get_spend_limits` | Read the account's spend limit windows. |
| `openai_ads_get_landing_page_crawl` | Read the landing page crawl evidence for an ad's submitted version. |
| `openai_ads_get_conversion_settings` | List conversion event settings, the goals a campaign can use. |
| `openai_ads_get_conversion_pixels` | List conversion pixels and connected pixel IDs. |
| `openai_ads_get_conversion_events` | List recent sampled conversion events, to check that a pixel or server integration sends data. |
| `openai_ads_get_conversion_insights` | Read attributed conversion totals or daily values, optionally by country or device. |
| `openai_ads_get_feeds` | List product feeds, optionally with product counts. |
| `openai_ads_get_feed_uploads` | List recent product feed uploads and their results. |
| `openai_ads_get_feed_settings` | Read a feed's display and organic-listing settings. |
| `openai_ads_get_feed_products` | List feed products that match ad group product filters. |
| `openai_ads_get_custom_audiences` | List custom audiences. |
| `openai_ads_get_custom_audience` | Read one custom audience and its matched count. |
| `openai_ads_get_audience_operations` | List the accepted operations of a custom audience. |
| `openai_ads_get_audience_operation` | Read the state of one custom audience operation. |
| `openai_ads_get_bulk_job` | Read the status of a Bulk API job. |
| `openai_ads_get_bulk_job_operations` | Read one page of a Bulk API job's operation outcomes. |
| `openai_ads_get_write_schema` | Read the pinned native request definitions, upload and bulk limits, and the exclusions. |
| `openai_ads_get_write_context` | Read the account, conversion settings and feeds before proposing a campaign, with the supported bid combinations. |
| `openai_ads_get_mutation` | Read a write preview or receipt held by this server process. |

</details>

<details>
<summary><b>28 write tools</b></summary>

Disabled by default. Calls preview unless explicitly confirmed. Check the configuration and exact schema before use.

| Tool | Purpose |
| --- | --- |
| `openai_ads_create_campaign` | Create a paused campaign with its objective, budget, schedule and targeting. |
| `openai_ads_update_campaign` | Update campaign settings such as budget, schedule or targeting. |
| `openai_ads_pause_campaign` | Pause a campaign. |
| `openai_ads_activate_campaign` | Activate a campaign. Can spend budget; requires `OPENAI_ADS_ENABLE_ACTIVATION`. |
| `openai_ads_archive_campaign` | Archive a campaign. |
| `openai_ads_create_ad_group` | Create a paused ad group with its bidding, context hints and product set. |
| `openai_ads_update_ad_group` | Update ad group settings such as bidding or context hints. |
| `openai_ads_pause_ad_group` | Pause an ad group. |
| `openai_ads_activate_ad_group` | Activate an ad group. Can spend budget; requires `OPENAI_ADS_ENABLE_ACTIVATION`. |
| `openai_ads_archive_ad_group` | Archive an ad group. |
| `openai_ads_create_ad` | Create a paused ad with a chat card or product template creative, which enters review. |
| `openai_ads_update_ad` | Update an ad's name or creative. A creative edit starts a new review. |
| `openai_ads_pause_ad` | Pause an ad. |
| `openai_ads_activate_ad` | Activate an ad. Can spend budget; requires `OPENAI_ADS_ENABLE_ACTIVATION`. |
| `openai_ads_archive_ad` | Archive an ad. |
| `openai_ads_create_ad_preview` | Create a temporary preview of an existing ad. |
| `openai_ads_rename_campaign` | Rename a campaign. The name is the only field that changes. |
| `openai_ads_rename_ad_group` | Rename an ad group. The name is the only field that changes. |
| `openai_ads_rename_ad` | Rename an ad. The name is the only field that changes. |
| `openai_ads_upload_image` | Upload PNG, JPEG or WebP bytes of at least 640 x 640 and return a file ID for a chat card. |
| `openai_ads_upload_image_url` | Have OpenAI import a public HTTPS image and return a file ID. |
| `openai_ads_create_conversion_setting` | Create a conversion event setting for a standard or custom event. |
| `openai_ads_create_conversion_pixel` | Create a conversion pixel. |
| `openai_ads_create_feed` | Create a product feed. |
| `openai_ads_update_feed_settings` | Update a feed's display name and organic-listing settings. |
| `openai_ads_update_feed_products` | Update the title, price or availability of up to 500 existing product variants. |
| `openai_ads_archive_feed` | Archive a product feed. |
| `openai_ads_submit_bulk_job` | Submit a Bulk API job of up to 1,000 operations, validation only by default. |

</details>

<details>
<summary><b>1 resource</b></summary>

| Resource | Content |
| --- | --- |
| `openai-ads://guide` | Account scope, write flow, units, rate limits, supported metrics, levels, breakdowns and attribution options. |

</details>

## License

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE).

## More from getmcpads

[Meta Ads](https://github.com/get-mcp-ads/meta-ads-mcp-server) · [Google Ads](https://github.com/get-mcp-ads/google-ads-mcp-server) · [Google Analytics 4](https://github.com/get-mcp-ads/google-analytics-mcp-server) · [Google Search Console](https://github.com/get-mcp-ads/google-search-console-mcp-server) · [TikTok Ads](https://github.com/get-mcp-ads/tiktok-ads-mcp-server) · [Pinterest Ads](https://github.com/get-mcp-ads/pinterest-ads-mcp-server) · [X Ads](https://github.com/get-mcp-ads/x-ads-mcp-server)

Maintained by **Emmanuel** at [getmcpads](https://www.getmcpads.com). Questions: [hello@getmcpads.com](mailto:hello@getmcpads.com).
