import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ORPCError } from "@orpc/server";
import { consumeMcpRequestLimit, consumeMcpUserLimit } from "@reactive-resume/api/features/mcp/transport";
import { getTrustedOrigins } from "@reactive-resume/auth/trusted-origins";
import { env } from "@reactive-resume/env/server";
import { AuthError, authenticateRequest } from "./auth";
import { createMcpServer } from "./server";

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

/**
 * PostFolio stateless MCP transport.
 *
 * This initial adapter deliberately uses the already-installed SDK to process one
 * JSON-RPC request per HTTP POST, returns a complete application/json response,
 * and never retains transport/session state between calls. It removes the extra
 * initialize/initialized exchange from the HTTP route contract. The negotiated
 * MCP protocol version must still be confirmed against the target 2026-07-28 SDK
 * before this handler can claim full protocol conformance.
 */
export async function handleMcp(request: Request, trustedClient = "unknown") {
  let server: McpServer | undefined;
  let transport: WebStandardStreamableHTTPServerTransport | undefined;

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
      return errorResponse(415, "This stateless MCP endpoint accepts application/json requests.");
    }

    const accept = request.headers.get("accept") ?? "";
    if (!accept.split(",").some((entry) => entry.trim().split(";")[0].trim() === "application/json" || entry.trim() === "*/*")) {
      return errorResponse(406, "This stateless MCP endpoint returns application/json.");
    }

    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > 4 * 1024 * 1024) {
      return errorResponse(413, "MCP request body exceeds the 4 MiB limit.");
    }

    let payload: unknown;
    try {
      const body = await request.text();
      if (new TextEncoder().encode(body).byteLength > 4 * 1024 * 1024) {
        return errorResponse(413, "MCP request body exceeds the 4 MiB limit.");
      }
      payload = JSON.parse(body);
    } catch {
      return errorResponse(400, "Request body must contain valid JSON.");
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return errorResponse(400, "Request body must be one JSON-RPC object.");
    }

    const rpc = payload as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string" || !rpc.method) {
      return errorResponse(400, "Request must be a valid JSON-RPC 2.0 request.");
    }

    // The target stateless contract has no initialize handshake or server session.
    if (rpc.method === "initialize" || rpc.method === "notifications/initialized") {
      return errorResponse(400, "This MCP endpoint is stateless and does not support initialization handshakes.");
    }

    await consumeMcpRequestLimit(trustedClient);
    const authentication = await authenticateRequest(request);
    await consumeMcpUserLimit(authentication.user.id);

    const resHeaders = new Headers(responseHeaders);
    server = createMcpServer(request, authentication, trustedClient, resHeaders);
    transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: undefined,
      maxRequestBodySize: 4 * 1024 * 1024,
    });
    await server.connect(transport);

    // Compatibility bridge: issue one POST request and always produce a complete JSON response.
    // This is stateless at the HTTP level. Full 2026-07-28 conformance requires the matching SDK.
    const response = await transport.handleRequest(
      new Request(request.url, {
        method: "POST",
        headers: new Headers({ "content-type": "application/json", accept: "application/json" }),
        body: JSON.stringify(payload),
      }),
    );
    const bodyText = await response.text();
    const headers = new Headers(responseHeaders);
    headers.set("Content-Type", "application/json; charset=utf-8");
    for (const [key, value] of resHeaders) headers.set(key, value);
    if (!response.ok) return new Response(bodyText, { status: response.status, headers });
    return new Response(bodyText, { status: 200, headers });
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
  } finally {
    try {
      if (server) await server.close();
      else if (transport) await transport.close();
    } catch {
      console.error("[MCP] Transport cleanup failed");
    }
  }
}
