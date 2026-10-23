# Releasing

Releases are driven by a version tag. The `release.yml` workflow publishes npm, the GitHub release and the MCP Registry entry, in that order.

1. Update the version in `package.json`, `server.json` (both `version` fields) and `PACKAGE_VERSION` in `src/server.ts`. The test suite fails when they disagree.
2. Add a `## X.Y.Z - YYYY-MM-DD` section to `CHANGELOG.md`. The workflow uses it as the release notes and stops when it is missing.
3. Run `npm run catalog` to regenerate `server-card.json`, then `npm run typecheck`, `npm run lint` and `npm test`.
4. Merge the change into `main` after CI passes.
5. Tag the merged commit and push the tag:

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

6. The workflow checks that the tag matches `package.json`, runs the audit, typecheck, build and tests, then:
   - publishes `@getmcpads/chatgpt-ads-mcp-server` to npm with provenance through trusted publishing (OIDC), so no npm token is stored in the repository;
   - creates the GitHub release from the changelog section;
   - publishes `com.getmcpads/chatgpt-ads` to the MCP Registry, authenticated by the getmcpads.com DNS key.

Each step skips when its target already holds the version, so a partial release can be resumed with **Run workflow** and the existing tag. npm must list this repository and `release.yml` as a trusted publisher, and the repository needs the `MCP_DNS_PRIVATE_KEY` secret.
