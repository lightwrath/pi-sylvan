import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  createLongRunningMcpFetch,
  DEFAULT_AGENT_TOOL_TIMEOUT_MS,
  MAX_AGENT_TOOL_TIMEOUT_MS,
  MIN_AGENT_TOOL_TIMEOUT_MS,
  parseAgentToolTimeoutMs,
} from "../lib/long-running-mcp-fetch.ts";

const server = createServer((request, response) => {
  void (async () => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const rpc = JSON.parse(body) as { method?: string; params?: { name?: string } };
    await new Promise(resolve => setTimeout(resolve, 1_200));
    if (!response.destroyed) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { method: rpc.method, name: rpc.params?.name } }));
    }
  })().catch(() => undefined);
});

let endpoint: string;
const serverReady = new Promise<void>(resolve => {
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    endpoint = `http://127.0.0.1:${address.port}/mcp`;
    resolve();
  });
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

test("agent tool timeout defaults to 24 hours and accepts only bounded integer overrides", () => {
  assert.equal(parseAgentToolTimeoutMs(undefined), DEFAULT_AGENT_TOOL_TIMEOUT_MS);
  assert.equal(parseAgentToolTimeoutMs(String(MIN_AGENT_TOOL_TIMEOUT_MS)), MIN_AGENT_TOOL_TIMEOUT_MS);
  assert.equal(parseAgentToolTimeoutMs(String(MAX_AGENT_TOOL_TIMEOUT_MS)), MAX_AGENT_TOOL_TIMEOUT_MS);
  for (const value of ["0", "999", "86400001", "1e6", "not-a-number"]) {
    assert.throws(() => parseAgentToolTimeoutMs(value), /SYLVAN_MCP_TOOL_TIMEOUT_MS/);
  }
});

test("only long-running inference calls use the configured Undici header timeout", async () => {
  await serverReady;
  const http = createLongRunningMcpFetch(100, 0);
  try {
    await assert.rejects(http.fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_agent_session" } }),
    }), error => {
      assert.ok(error instanceof TypeError);
      assert.equal(error.message, "fetch failed");
      const cause = error.cause;
      assert.ok(cause && typeof cause === "object" && "code" in cause);
      assert.equal(cause.code, "UND_ERR_HEADERS_TIMEOUT");
      return true;
    });

    const ordinary = await http.fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_agent_sessions" } }),
    });
    assert.equal(ordinary.status, 200);
    assert.deepEqual(await ordinary.json(), {
      jsonrpc: "2.0", id: 1, result: { method: "tools/call", name: "list_agent_sessions" },
    });
  } finally {
    await http.close();
  }
});

test("SDK cancellation and timeout abort only their inference POSTs and leave the Agent reusable", async () => {
  type RequestId = string | number;
  type PendingCall = { id: RequestId; response: ServerResponse; disconnected: Promise<void> };
  const calls = createQueue<PendingCall>();
  const cancellations = createQueue<RequestId>();
  const server = createServer((request, response) => {
    if (request.method === "GET") { response.writeHead(405).end(); return; }
    if (request.method === "DELETE") { response.writeHead(204).end(); return; }
    void (async () => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const rpc = JSON.parse(body) as { id?: RequestId; method?: string; params?: { requestId?: RequestId } };
      if (rpc.method === "initialize") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          jsonrpc: "2.0", id: rpc.id,
          result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "0.1.0" } },
        }));
        return;
      }
      if (rpc.method === "notifications/cancelled") {
        cancellations.push(rpc.params?.requestId ?? "missing");
        response.writeHead(202).end();
        return;
      }
      if (rpc.method !== "tools/call" || rpc.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      let resolveDisconnected!: () => void;
      const disconnected = new Promise<void>(resolve => { resolveDisconnected = resolve; });
      response.once("close", () => { if (!response.writableEnded) resolveDisconnected(); });
      calls.push({ id: rpc.id, response, disconnected });
    })().catch(() => { if (!response.destroyed) response.destroy(); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const http = createLongRunningMcpFetch(5_000, 0);
  const client = new Client({ name: "timeout-fixture", version: "0.1.0" }, { capabilities: {} });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), { fetch: http.fetch }));

    const observer = new AbortController();
    const cancelledCall = client.callTool({ name: "create_agent_session", arguments: { spaceId: "space", message: "cancel" } }, undefined, { signal: observer.signal, timeout: 5_000 });
    const cancelledRequest = await calls.next();
    const siblingCall = client.callTool({ name: "create_agent_session", arguments: { spaceId: "space", message: "keep" } }, undefined, { timeout: 5_000 });
    const siblingRequest = await calls.next();
    observer.abort();
    await assert.rejects(cancelledCall);
    await cancelledRequest.disconnected;
    assert.equal(await cancellations.next(), cancelledRequest.id);
    assert.equal(siblingRequest.response.destroyed, false, "cancelling one observer must not abort a sibling request");
    respondToToolCall(siblingRequest);
    await siblingCall;

    const timedOutCall = client.callTool({ name: "send_agent_message", arguments: { spaceId: "space", sessionId: "native", message: "timeout" } }, undefined, { timeout: 100 });
    const timedOutRequest = await calls.next();
    await assert.rejects(timedOutCall, /Request timed out/);
    await timedOutRequest.disconnected;
    assert.equal(await cancellations.next(), timedOutRequest.id);

    const recoveryCall = client.callTool({ name: "create_agent_session", arguments: { spaceId: "space", message: "after timeout" } }, undefined, { timeout: 5_000 });
    const recoveryRequest = await calls.next();
    respondToToolCall(recoveryRequest);
    await recoveryCall;
  } finally {
    await client.close();
    await http.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("body cancellation and session shutdown abort responses after headers without disturbing siblings", async () => {
  type RequestId = string | number;
  type PendingBody = { id: RequestId; response: ServerResponse; disconnected: Promise<void> };
  const stalledBodies = createQueue<PendingBody>();
  const cancellations = createQueue<RequestId>();
  const server = createServer((request, response) => {
    if (request.method === "GET") { response.writeHead(405).end(); return; }
    if (request.method === "DELETE") { response.writeHead(204).end(); return; }
    void (async () => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const rpc = JSON.parse(body) as {
        id?: RequestId;
        method?: string;
        params?: { name?: string; requestId?: RequestId; arguments?: { message?: string } };
      };
      if (rpc.method === "initialize") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          jsonrpc: "2.0", id: rpc.id,
          result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "0.1.0" } },
        }));
        return;
      }
      if (rpc.method === "notifications/cancelled") {
        cancellations.push(rpc.params?.requestId ?? "missing");
        response.writeHead(202).end();
        return;
      }
      if (rpc.method !== "tools/call" || rpc.id === undefined) {
        response.writeHead(202).end();
        return;
      }

      if (rpc.params?.arguments?.message !== "stall-body") {
        respondToToolCall({ id: rpc.id, response });
        return;
      }

      let resolveDisconnected!: () => void;
      const disconnected = new Promise<void>(resolve => { resolveDisconnected = resolve; });
      response.once("close", () => { if (!response.writableEnded) resolveDisconnected(); });
      response.writeHead(200, { "content-type": "application/json" });
      response.flushHeaders();
      response.write(`{"jsonrpc":"2.0","id":${JSON.stringify(rpc.id)},"result":`);
      // Ensure fetch has received headers and the SDK is waiting for the body before cancellation.
      await new Promise(resolve => setTimeout(resolve, 50));
      stalledBodies.push({ id: rpc.id, response, disconnected });
    })().catch(() => { if (!response.destroyed) response.destroy(); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const http = createLongRunningMcpFetch(5_000, 0);
  const client = new Client({ name: "body-cancel-fixture", version: "0.1.0" }, { capabilities: {} });
  let clientClosed = false;
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), { fetch: http.fetch }));

    const observer = new AbortController();
    const cancelledCall = client.callTool({ name: "create_agent_session", arguments: { spaceId: "space", message: "stall-body" } }, undefined, { signal: observer.signal, timeout: 5_000 });
    const cancelledBody = await stalledBodies.next();
    const siblingCall = await client.callTool({ name: "create_agent_session", arguments: { spaceId: "space", message: "sibling" } }, undefined, { timeout: 5_000 });
    assert.equal(siblingCall.isError, false);
    observer.abort();
    await assert.rejects(cancelledCall);
    await within(cancelledBody.disconnected, 1_000, "cancel did not close the stalled response body");
    assert.equal(await cancellations.next(), cancelledBody.id);

    const closingCall = client.callTool({ name: "create_agent_session", arguments: { spaceId: "space", message: "stall-body" } }, undefined, { timeout: 5_000 })
      .then(() => "resolved", () => "rejected");
    const closingBody = await stalledBodies.next();
    const closeStarted = Date.now();
    await client.close();
    clientClosed = true;
    await within(closingBody.disconnected, 1_000, "session close did not abort the stalled response body");
    assert.equal(await within(closingCall, 1_000, "session close left the SDK request pending"), "rejected");
    await within(http.close(), 1_000, "closing the Undici Agent waited for the stalled response");
    assert.ok(Date.now() - closeStarted < 1_000);
  } finally {
    if (!clientClosed) await client.close();
    await http.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

function within<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

function respondToToolCall(request: { id: string | number; response: ServerResponse }): void {
  request.response.writeHead(200, { "content-type": "application/json" });
  request.response.end(JSON.stringify({
    jsonrpc: "2.0", id: request.id,
    result: { content: [{ type: "text", text: "complete" }], isError: false },
  }));
}

function createQueue<T>() {
  const values: T[] = [];
  const waiters: Array<(value: T) => void> = [];
  return {
    push(value: T): void {
      const waiter = waiters.shift();
      if (waiter) waiter(value);
      else values.push(value);
    },
    next(): Promise<T> {
      const value = values.shift();
      if (value !== undefined) return Promise.resolve(value);
      return new Promise(resolve => waiters.push(resolve));
    },
  };
}
