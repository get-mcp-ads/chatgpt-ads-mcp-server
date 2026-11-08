# Contributing

Thank you for considering a contribution. This project is maintained by [getmcpads](https://www.getmcpads.com) and accepts outside patches.

## Getting set up

```bash
git clone https://github.com/get-mcp-ads/chatgpt-ads-mcp-server.git
cd chatgpt-ads-mcp-server
npm ci
cp .env.example .env
npm run typecheck && npm run lint && npm run build && npm test
```

CI runs the same checks on Node.js 22, 24 and 26.

## Ground rules

- **Never commit a key.** `.env` is ignored by git. Read your diff before opening a pull request.
- **Tests run offline.** They use synthetic responses through a mocked `fetch` and never contact a live ad account.
- **Native schemas come from the public OpenAPI document.** Refresh them with `node scripts/generate-contracts.mjs <saved openapi.json> <date>` and record the new revision in `SOURCE_SYNC.md`. Never copy text from documentation that is not public.
- **Writes preview first.** A new write tool takes `confirm`, returns a preview without it, and applies only the saved preview. Creations stay paused, and activation stays behind `OPENAI_ADS_ENABLE_ACTIVATION`.
- **No automatic retries.** A write with an uncertain outcome must never be resubmitted by the server.
- **One host, no redirects.** Two tests fail when a fetch omits `redirect: "error"` or when a host other than `api.ads.openai.com` appears in `src/`.
- **Stay self-contained.** Runtime dependencies are `@modelcontextprotocol/sdk` and `zod`. Hosted features such as galleries, launch plans, alerts and exports belong to the hosted product.
- **Write plain English.** No em dashes, no rhetorical questions, no superlatives.

## Pull requests

One logical change per pull request. Explain why the change is needed. When you fix a bug, add the test that would have caught it.

Report bugs with what you called, what you expected and what you got, with IDs and keys removed. For security problems, see [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the Apache License 2.0, as stated in [LICENSE](LICENSE).
