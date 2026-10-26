# PostFolio deployment plan

## Hosting layout

- Project/application repository: https://github.com/R2Pitou/post-folio
- Public application URL: https://postfolio.working-draft.org
- Existing site https://working-draft.org remains untouched.
- DNS is managed by the user's Cloudflare account. Do not add or change a DNS record until a deployment origin is selected and the correct record type/target is confirmed.
- GitHub hosts source and CI. The application is not a GitHub Pages site: it needs a server runtime, PostgreSQL, file storage, and OAuth callbacks.

## Current repository state

The repository is an upstream Reactive Resume v6 source copy. The target MCP server currently uses `@modelcontextprotocol/sdk` v1.x and a Streamable HTTP transport handler. Its local tests expect the 2025-11-25 initialize flow.

## Next engineering steps

1. Implement a conformant stateless transport using an SDK/revision that explicitly supports MCP 2026-07-28. Do not claim conformance by merely wrapping the old transport or rejecting initialize inside it.
2. Keep OAuth endpoints on the app origin. Verify protected-resource metadata, authorization-server metadata, registration/PKCE behavior, and consent in an end-to-end test.
3. Add protocol tests for POST JSON request handling, no initialize exchange, no protocol session IDs, request-version metadata as required by the target revision, JSON responses for non-streaming tool calls, and request-scoped streaming only where called for.
4. Keep the existing resume schema and import/export contracts compatible with upstream until a justified schema migration exists.
5. Package and build locally, run focused tests, type checks, and full CI before deploying.
6. Choose deployment target: Moria Docker is likely the most directly controllable if PostgreSQL and storage capacity are available; Cloudflare Workers is possible but requires Workers Paid, PostgreSQL via Hyperdrive, private R2 storage and Durable Objects according to upstream documentation.
7. Once there is a reachable deployment origin, configure Cloudflare DNS for `postfolio.working-draft.org`; ensure TLS, reverse proxy, OAuth APP_URL and trusted proxy configuration match that exact host.
8. Verify `https://postfolio.working-draft.org/api/health`, MCP discovery metadata, OAuth authorization, resume import/create/export, and backup/restore before inviting external users.

## Safety and scope

- Never commit .env files, API keys, OAuth client secrets, auth secrets, database URLs, or real user CVs.
- Do not change DNS until the target origin is known.
- Do not modify the existing Working-Draft.org Jekyll repository to serve the application.
- Retain the upstream MIT licence and copyright notice; distinguish PostFolio's modifications in the fork.
