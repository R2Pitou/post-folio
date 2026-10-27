# PostFolio deployment plan

## Hosting layout

- Project/application repository: https://github.com/R2Pitou/post-folio
- Public application URL: https://postfolio.working-draft.org
- Existing site https://working-draft.org remains untouched.
- DNS is managed by the user's Cloudflare account. Do not add or change a DNS record until a deployment origin is selected and the correct record type/target is confirmed.
- GitHub hosts source and CI. The application is not a GitHub Pages site: it needs a server runtime, PostgreSQL, file storage, and OAuth callbacks.

## Current repository state

The repository is an upstream Reactive Resume v6 source copy. The MCP implementation is being migrated to `@modelcontextprotocol/server` v2 and `createMcpHandler`, the official TypeScript SDK entry point for MCP 2026-07-28. The application still needs tests and integration verification before it can claim conformance.

## Next engineering steps

1. Complete the SDK v2 migration end to end. Use `createMcpHandler` and a fresh server per request. Do not manually reject `initialize` while still relying on the v1 transport.
2. Keep OAuth endpoints on the app origin. Verify protected-resource metadata, authorization-server metadata, registration/PKCE behavior, and consent in an end-to-end test.
3. Add protocol tests for POST JSON request handling, no initialize exchange, no protocol session IDs, request-version metadata as required by the target revision, JSON responses for non-streaming tool calls, and request-scoped streaming only where called for.
4. Keep the existing resume schema and import/export contracts compatible with upstream until a justified schema migration exists.
5. Regenerate `pnpm-lock.yaml` using the repository's pinned pnpm version, then run focused tests, type checks, full CI, and a production build before deploying.
6. Choose deployment target: Moria Docker is likely the most directly controllable if PostgreSQL and storage capacity are available; Cloudflare Workers is possible but requires Workers Paid, PostgreSQL via Hyperdrive, private R2 storage and Durable Objects according to upstream documentation.
7. Once there is a reachable deployment origin, configure Cloudflare DNS for `postfolio.working-draft.org`; ensure TLS, reverse proxy, OAuth APP_URL and trusted proxy configuration match that exact host.
8. Verify `https://postfolio.working-draft.org/api/health`, MCP discovery metadata, OAuth authorization, resume import/create/export, and backup/restore before inviting external users.

## Safety and scope

- Never commit .env files, API keys, OAuth client secrets, auth secrets, database URLs, or real user CVs.
- Do not change DNS until the target origin is known.
- Do not modify the existing Working-Draft.org Jekyll repository to serve the application.
- Retain the upstream MIT licence and copyright notice; distinguish PostFolio's modifications in the fork.
