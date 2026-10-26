import { beforeEach, expect, it, vi } from "vite-plus/test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ORPCError } from "@orpc/server";

const mocks = vi.hoisted(() => ({ authentication: vi.fn(), limit: vi.fn() }));
vi.mock("@reactive-resume/env/server", () => ({ env: { APP_URL: "https://resume.example" } }));
vi.mock("@reactive-resume/api/context", () => ({ resolveAuthenticationFromRequestHeaders: mocks.authentication }));
vi.mock("@reactive-resume/api/features/mcp/transport", () => ({
  consumeMcpRequestLimit: mocks.limit,
  consumeMcpUserLimit: mocks.limit,
}));
vi.mock("./server", () => ({
  createMcpServer: () => new McpServer({ name: "transport-test", version: "1.0.0" }),
}));

import { handleMcp } from "./handler";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.limit.mockResolvedValue(undefined);
  mocks.authentication.mockResolvedValue({ user: { id: "user-1" }, method: "bearer", permissions: ["read"] });
});

function request(body: unknown, origin?: string) {
  return new Request("https://resume.example/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(origin && { Origin: origin }),
    },
    body: JSON.stringify(body),
  });
}

it("rejects initialize handshakes in stateless mode", async () => {
  const response = await handleMcp(request({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  }), "127.0.0.1");
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining("does not support initialization") } });
  expect(mocks.authentication).not.toHaveBeenCalled();
});

it("rejects initialized notifications because no handshake exists", async () => {
  const response = await handleMcp(request({ jsonrpc: "2.0", method: "notifications/initialized" }), "127.0.0.1");
  expect(response.status).toBe(400);
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

it("rejects malformed JSON and oversized payloads", async () => {
  const malformed = await handleMcp(new Request("https://resume.example/mcp", {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: "{",
  }));
  expect(malformed.status).toBe(400);
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
