import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { consumeMcpRequestLimit, consumeMcpUserLimit } from "@reactive-resume/api/features/mcp/transport";
import { getTrustedOrigins } from "@reactive-resume/auth/trusted-origins";
import { env } from "@reactive-resume/env/server";
import { AuthError, authenticateRequest } from "./auth";
import { createAuthenticatedMcpHandler } from "./server";

const TRUSTED_ORIGINS = getTrustedOrigins(env.APP_URL);
const responseHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function errorResponse(status: number, message: string, headers?: Record<string, string>) {
  return Response.json(
    { id: null, jsonrpc: "2.0", error: { code: -32603, message } },
    { status, headers: { ...responseHeaders, ...headers } },
  );
}

/** MCP 2026-07-28 per-request endpoint. OAuth is resolved before the SDK is invoked. */
export async function handleMcp(request: Request, trustedClient = "unknown") {
  try {
    const origin = request.headers.get("origin");
    if (origin !== null && !TRUSTED_ORIGINS.includes(origin)) {
      return errorResponse(403, "Origin is not allowed. Use the configured application origin or a native MCP client.");
    }

    if (request.method !== "POST") {
      return errorResponse(405, "This stateless MCP endpoint accepts POST requests.", { Allow: "POST" });
    }

    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      return errorResponse(415, "This MCP endpoint accepts application/json requests.");
    }

    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > 4 * 1024 * 1024) {
      return errorResponse(413, "MCP request body exceeds the 4 MiB limit.");
    }

    const payloadText = await request.clone().text();
    if (new TextEncoder().encode(payloadText).byteLength > 4 * 1024 * 1024) {
      return errorResponse(413, "MCP request body exceeds the 4 MiB limit.");
    }

    await consumeMcpRequestLimit(trustedClient);
    const authentication = await authenticateRequest(request);
    await consumeMcpUserLimit(authentication.user.id);

    const resHeaders = new Headers(responseHeaders);
    const handler = createAuthenticatedMcpHandler(request, authentication, trustedClient, resHeaders);

    // The v2 SDK validates the per-request MCP envelope, required transport headers,
    // protocol version, method, content negotiation and JSON/SSE response semantics.
    const response = await handler.fetch(request);
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    for (const [key, value] of resHeaders) headers.set(key, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } catch (error) {
    if (error instanceof AuthError) {
      return errorResponse(401, "Unauthorized", {
        "WWW-Authenticate": `Bearer resource_metadata="${env.APP_URL}/.well-known/oauth-protected-resource"`,
      });
    }
    if (error instanceof ORPCError && error.code === "TOO_MANY_REQUESTS") {
      const reset = (error.data as { reset?: number } | undefined)?.reset;
      return errorResponse(429, "Too many MCP requests. Retry after the rate limit resets.", {
        "Retry-After": String(reset ? Math.max(1, Math.ceil((reset - Date.now()) / 1000)) : 60),
      });
    }
    const diagnosticId = randomUUID();
    console.error("[MCP] Request failed", { diagnosticId, name: error instanceof Error ? error.name : "Unknown" });
    return errorResponse(500, `MCP request failed. Retry or contact support with diagnostic ID ${diagnosticId}.`);
  }
}
