import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerSylvan from "../extensions/index.ts";
import { AgentCallOutcomeUnknownError } from "../lib/sub-agent.ts";

const originalUrl = process.env.SYLVAN_MCP_URL;
const originalRun = process.env.SYLVAN_AGENT_RUN_ID;
afterEach(() => {
  if (originalUrl === undefined) delete process.env.SYLVAN_MCP_URL; else process.env.SYLVAN_MCP_URL = originalUrl;
  if (originalRun === undefined) delete process.env.SYLVAN_AGENT_RUN_ID; else process.env.SYLVAN_AGENT_RUN_ID = originalRun;
});

for (const failure of ["http-504", "malformed-json"] as const) {
  test(`${failure} after inference submission is reported as an unknown outcome`, async () => {
    let submitted = 0;
    const server = createServer(async (request, response) => {
      if (request.method === "GET") { response.writeHead(405).end(); return; }
      if (request.method === "DELETE") { response.writeHead(204).end(); return; }
      let body = "";
      for await (const chunk of request) body += chunk;
      const rpc = JSON.parse(body) as { id?: number; method?: string };
      if (rpc.id === undefined) { response.writeHead(202).end(); return; }
      if (rpc.method === "initialize") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          jsonrpc: "2.0", id: rpc.id,
          result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "0.1.0" } },
        }));
        return;
      }
      if (rpc.method === "tools/call") {
        submitted++;
        if (failure === "http-504") {
          response.writeHead(504, { "content-type": "text/plain" }).end("Gateway Timeout");
        } else {
          response.writeHead(200, { "content-type": "application/json" }).end("{\"jsonrpc\":");
        }
        return;
      }
      response.writeHead(400).end();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    process.env.SYLVAN_MCP_URL = `http://127.0.0.1:${address.port}/mcp`;
    process.env.SYLVAN_AGENT_RUN_ID = "fixture-run";
    const tools = new Map<string, any>();
    let shutdown: (() => Promise<void>) | undefined;
    try {
      registerSylvan({
        registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
        on: (_event: string, handler: () => Promise<void>) => { shutdown = handler; },
      } as unknown as ExtensionAPI);
      await assert.rejects(
        tools.get("create_agent_session").execute("uncertain-call", { spaceId: "destination", message: "start" }),
        (error: unknown) => {
          assert.ok(error instanceof AgentCallOutcomeUnknownError);
          assert.match(error.message, /outcome .* unknown/i);
          assert.match(error.message, /may have reached Sylvan/);
          assert.match(error.message, /does not prove the operation failed before starting/);
          assert.match(error.message, /list_agent_sessions/);
          assert.match(error.message, /fresh tool call gets a new request ID and may duplicate/);
          return true;
        },
      );
      assert.equal(submitted, 1, "the test response must follow an actual tools/call submission");
    } finally {
      await shutdown?.();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}

test("an already-aborted inference call is rejected before submission", async () => {
  let requests = 0;
  let inferenceSubmissions = 0;
  const server = createServer(async (request, response) => {
    requests++;
    if (request.method === "GET") { response.writeHead(405).end(); return; }
    if (request.method === "DELETE") { response.writeHead(204).end(); return; }
    let body = "";
    for await (const chunk of request) body += chunk;
    const rpc = JSON.parse(body) as { id?: number; method?: string };
    if (rpc.id === undefined) { response.writeHead(202).end(); return; }
    if (rpc.method === "initialize") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        jsonrpc: "2.0", id: rpc.id,
        result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "0.1.0" } },
      }));
      return;
    }
    if (rpc.method === "tools/call") {
      inferenceSubmissions++;
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: "[]" }], isError: false },
      }));
      return;
    }
    response.writeHead(400).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  process.env.SYLVAN_MCP_URL = `http://127.0.0.1:${address.port}/mcp`;
  process.env.SYLVAN_AGENT_RUN_ID = "fixture-run";
  const tools = new Map<string, any>();
  let shutdown: (() => Promise<void>) | undefined;
  try {
    registerSylvan({
      registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
      on: (_event: string, handler: () => Promise<void>) => { shutdown = handler; },
    } as unknown as ExtensionAPI);

    await tools.get("list_agent_sessions").execute("initial-call", { spaceId: "destination" });
    assert.equal(inferenceSubmissions, 1);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      tools.get("create_agent_session").execute("pre-aborted-call", { spaceId: "destination", message: "must not submit" }, controller.signal),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, "AbortError");
        assert.ok(!(error instanceof AgentCallOutcomeUnknownError));
        return true;
      },
    );
    assert.equal(inferenceSubmissions, 1, "the pre-aborted tool call must not reach tools/call");
  } finally {
    await shutdown?.();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  assert.ok(requests > 0, "the initial list call should have established the connection");
});
