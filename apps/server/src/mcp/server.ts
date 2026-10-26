import type { RequestAuthentication } from "@reactive-resume/api/context";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { onError } from "@orpc/client";
import { createRouterClient } from "@orpc/server";
import {
  buildMcpServerInfo,
  MCP_TOOL_NAME,
  MCP_ROUTER,
  registerParityTools,
  registerPrompts,
  registerResources,
  registerTools,
  registerToolDiscovery,
} from "@reactive-resume/mcp";
import { appVersion } from "../app-version";
import { getRequestLocale } from "../rpc/locale";

type McpRequestAuthentication = RequestAuthentication & {
  user: RequestAuthentication["user"];
};

function createRequestClient(
  request: Request,
  authentication: McpRequestAuthentication,
  trustedClient: string,
  resHeaders: Headers,
) {
  const reqHeaders = new Headers(request.headers);
  reqHeaders.delete("cookie");
  return createRouterClient(MCP_ROUTER, {
    interceptors: [
      (options) => {
        request.signal.throwIfAborted();
        return options.next({
          ...options,
          signal: options.signal ? AbortSignal.any([request.signal, options.signal]) : request.signal,
        });
      },
      onError((error) => {
        console.error("[MCP oRPC]", { name: error instanceof Error ? error.name : "Unknown" });
      }),
    ],
    context: () => ({
      locale: getRequestLocale(request),
      reqHeaders,
      resHeaders,
      trustedClient,
      authentication,
    }),
  });
}

/**
 * Create a fresh MCP server for one authenticated HTTP request.
 * The v2 SDK implements the 2026-07-28 request envelope and does not use
 * initialize/initialized or a protocol-level session ID.
 */
function createAuthenticatedServer(
  request: Request,
  authentication: McpRequestAuthentication,
  trustedClient: string,
  resHeaders: Headers,
) {
  const server = new McpServer(buildMcpServerInfo(appVersion), {
    instructions: [
      "PostFolio holds the user's resumes, cover letters and job applications.",
      `Find resume IDs with \`${MCP_TOOL_NAME.listResumes}\` and read one with \`${MCP_TOOL_NAME.getResume}\`; the resume JSON Schema is the \`resume://_meta/schema\` resource.`,
      `Edit resume content with JSON Patch through \`${MCP_TOOL_NAME.patchResume}\`, and change a resume's name, slug, tags or public visibility with \`${MCP_TOOL_NAME.updateResume}\`.`,
      `Track job applications with the application tools, starting from \`${MCP_TOOL_NAME.listApplications}\`.`,
      `Get a short-lived PDF link with \`${MCP_TOOL_NAME.downloadResumePdf}\`; export cover letters with \`${MCP_TOOL_NAME.exportCoverLetter}\`.`,
      "Tools named api_* expose the REST API. Operations involving passwords, API keys or AI provider keys return a link to finish in the application.",
    ].join(" "),
  });

  const client = createRequestClient(request, authentication, trustedClient, resHeaders);
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  registerResources(server, client);
  registerTools(server, client, headers, authentication);
  registerParityTools(server, client, headers, {
    authentication,
    resHeaders,
    trustedClient,
    locale: getRequestLocale(request),
    signal: request.signal,
  });
  registerPrompts(server, client);
  registerToolDiscovery(server);
  return server;
}

export function createAuthenticatedMcpHandler(
  request: Request,
  authentication: McpRequestAuthentication,
  trustedClient: string,
  resHeaders: Headers,
) {
  return createMcpHandler(
    () => createAuthenticatedServer(request, authentication, trustedClient, resHeaders),
    { legacy: "reject" },
  );
}
