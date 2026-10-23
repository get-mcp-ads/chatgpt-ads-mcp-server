# Security Policy

This server holds an Advertiser API key that can read, and when writes are enabled change, a live ChatGPT Ads account.

## Reporting a vulnerability

Do not open a public issue for a security problem. Use GitHub's private vulnerability reporting on this repository:
[Report a vulnerability](https://github.com/get-mcp-ads/chatgpt-ads-mcp-server/security/advisories/new), or write to hello@getmcpads.com. Do not include live keys or customer data.

We aim to acknowledge a report within 3 business days and to ship a fix or a documented mitigation within 30 days.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.x     | Yes       |

## What this server does with your key

- The key is read once from `OPENAI_ADS_API_KEY` at startup and kept in memory. It is never written to disk, logged, echoed or returned.
- One host is contacted: `api.ads.openai.com`. A test fails the build if another host appears in the source.
- No fetch follows a redirect. Every request sets `redirect: "error"`, and a redirect response is refused without reading its location. A test fails the build if a fetch omits it.
- Every request has a 30 second timeout, and a response larger than 8 MiB is refused.
- Provider error text is returned only for validation errors, after the key and bearer-like strings are removed, and truncated to 500 characters.
- No telemetry, analytics or other outbound traffic.

## Account scope

Every tool takes the account ID configured in `OPENAI_ADS_ACCOUNT_ID` and refuses any other before a request is made. The first request checks that the key belongs to that account and stops if it does not.

## Image URLs

`openai_ads_upload_image_url` hands a URL to OpenAI, which downloads the image. This server never fetches it. The URL must be public HTTPS without credentials or a fragment; loopback, private, link-local, metadata and IPv6 literal addresses are refused.

## Writes

Writes are registered only with `OPENAI_ADS_ENABLE_WRITES=true`. Each write previews first, binds the approval to the native state it read, and applies only that preview with `confirm: true`. Activation needs `OPENAI_ADS_ENABLE_ACTIVATION=true`. A write whose outcome is uncertain is recorded as UNKNOWN and never resubmitted.

## Handling your key safely

- Create a dedicated key in Ads Manager settings for this server, and revoke it when you stop using it.
- Your MCP client configuration file is usually plain text. Check its permissions and never commit it.
- OpenAI's Advertising Terms require you to keep API keys confidential and not to share them with third parties without OpenAI's approval.

## Scope

Vulnerabilities in the ChatGPT Ads API itself are out of scope here; report those to OpenAI.
