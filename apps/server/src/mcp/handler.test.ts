import { beforeEach, expect, it, vi } from "vite-plus/test";
import { ORPCError } from "@orpc/server";

const mocks = vi.hoisted(() => ({ authentication: vi.fn(), limit: vi.fn(), sdkFetch: vi.fn() }));
vi.mock("@reactive-resume/env/server", () => ({ env: { APP_URL: "https://resume.example" } }));
vi.mock("@reactive-resume/api/context", () => ({ resolveAuthenticationFromRequestHeaders: mocks.authentication }));
vi.mock("@reactive-resume/api/features/mcp/transport", () => ({
  consumeMcpRequestLimit: mocks.limit,
  consumeMcpUserLimit: mocks.limit,
}));
vi.mock("./server", () => ({
  createAuthenticatedMcpHandler: vi.fn(() => ({ fetch: mocks.sdkFetch })),
}));

import { handleMcp } from "./handler";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.limit.mockResolvedValue(undefined);
  mocks.authentication.mockResolvedValue({ user: { id: "user-1" }, method: "bearer", permissions: ["read"] });
  mocks.sdkFetch.mockImplementation(async (request: Request) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
});

function request(body: unknown, origin?: string, headers: Record<string, string> = {}) {
  return new Request("https://resume.example/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...headers,
      ...(origin && { Origin: origin }),
    },
    body: JSON.stringify(body),
  });
}

it("routes valid requests to the SDK v2 per-request handler without an initialize exchange", async () => {
  const response = await handleMcp(request({
    jsonrpc: "2.0", id: 1, method: "tools/list",
    params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
  }), undefined, { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list", "Mcp-Name": "tools/list" });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(mocks.sdkFetch).toHaveBeenCalledOnce();
});

it("rejects foreign origins before authentication", async () => {
  const response = await handleMcp(request({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "https://attacker.example"));
  expect(response.status).toBe(403);
  expect(mocks.authentication).not.toHaveBeenCalled();
});

it("rejects GET and non-JSON requests", async () => {
  const get = await handleMcp(new Request("https://resume.example/mcp", { method: "GET" }));
  expect(get.status).toBe(405);
  const form = await handleMcp(new Request("https://resume.example/mcp", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: "x=1",
  }));
  expect(form.status).toBe(415);
});

it("rejects oversized payloads", async () => {
  const large = await handleMcp(new Request("https://resume.example/mcp", {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ data: "x".repeat(4 * 1024 * 1024) }),
  }));
  expect(large.status).toBe(413);
});

it("returns actionable rate limits and conceals unexpected errors", async () => {
  mocks.limit.mockRejectedValueOnce(new ORPCError("TOO_MANY_REQUESTS", { data: { reset: Date.now() + 30_000 } }));
  const limited = await handleMcp(request({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
  expect(limited.status).toBe(429);
  expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  mocks.authentication.mockRejectedValueOnce(new Error("private database connection string"));
  const failed = await handleMcp(request({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
  expect(failed.status).toBe(500);
  expect(await failed.text()).not.toContain("private database connection string");
});
