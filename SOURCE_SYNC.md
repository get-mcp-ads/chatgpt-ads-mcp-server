# Source synchronization

Reviewed on 2026-10-23 against getmcpads gateway revision `3e1c2c8` (`apps/mcp/src/sources/openai_ads`, `packages/db/src/openai-ads*.ts` and `apps/mcp/src/launcher/media-dimensions.ts`).

## Synchronized

- All 58 gateway tools under their gateway names: 30 reads and 28 writes, plus the `openai-ads://guide` resource.
- The client: fixed host, account scoping, error mapping including Cloudflare 1010 and the Bulk API 404, the minimum daily budget constraint, list and insights pagination with `last_id`, repeated-cursor and truncation checks, country, device and platform breakdowns, and attribution windows.
- The pinned operation contracts, identical to the gateway's: generated from the public OpenAPI document retrieved on 2026-10-14, sha256 `266e7e19e7bb9f830a7b32916205ab8ca6b309422ca72c21f6b7dced42c9514a`. The document served on 2026-10-23 has the same hash. `scripts/generate-contracts.mjs` reproduces the file from a saved copy.
- The Bulk API body schema, documented on developers.openai.com/ads/bulk-api and absent from the OpenAPI document.
- The write protections: paused creation, the separate activation gate, local validation of budgets, bids, schedules and creatives, preview fingerprints, the stale-state check before applying, native readback verification, parent membership checks, product feed snapshots in minor currency units, and the rule that an uncertain write is never resubmitted.
- Image header inspection for uploads (PNG, JPEG, WebP).

## Adapted for a standalone server

- Previews and receipts are kept in memory for the life of the process instead of a database. A restart forgets them. Creations still send the requestId as the native `Idempotency-Key`.
- The key's account is verified on the first request instead of during a hosted onboarding step.
- `openai_ads_list_ad_creatives` returns native creative fields (`file_id`, `image_url`, `title`, `body`, `target_url`, review status) instead of the gallery item shape.
- Requests use `redirect: "error"` instead of `"manual"`, carry a 30 second timeout and refuse responses over 8 MiB.
- Validation errors (400, 404, 409, 422) and HTTP 200 responses carrying an error object return the native message after redaction, truncated to 500 characters. The gateway returns only its own messages.
- Configuration comes from four environment variables instead of encrypted connection records and deployment flags.

## Hosted only

Workspaces and account selection, encrypted credential storage, the durable mutation database, the Launcher (campaign plans, media import and frozen media), business and landing page reviews, creative galleries and creative evidence, MCP Apps UI and ChatGPT widget metadata, Google Sheets and data exports, change history and mutation audit, client memory, telemetry callbacks, billing and plans, and the discovery meta-tools.

## Left out by both

The gateway and this server deliberately exclude API key provisioning, billing and spend limit changes, account administration, partner account creation, custom audience creation and membership uploads, lead sync webhooks and SFTP credential provisioning, although the OpenAPI document describes them.

Validation uses synthetic data. No live advertising request or write is made by the test suite. The generated `server-card.json` is the source of truth for this revision's tool schemas.

Maintainer: Emmanuel, getmcpads. Contact: hello@getmcpads.com.
