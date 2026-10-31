import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerSylvan from "../extensions/index.ts";

test("real MCP transport binds initialization to the process and returns unwrapped assistant content", async () => {
  const originalUrl = process.env.SYLVAN_MCP_URL;
  const originalRun = process.env.SYLVAN_AGENT_RUN_ID;
  const requests: Array<{ method: string; run: unknown; name?: string; args?: unknown }> = [];
  const rootShellResponse = {
    id: "root-shell", name: "Root Shell", status: "Running", isSpaceShell: true,
    createdAt: "2026-10-31T00:00:00Z", exitedAt: null, exitCode: null, columns: 80, rows: 24,
  };
  const rootCommandResponse = { shellId: "root-shell", exitCode: 0, output: "fixture output", truncated: false, status: "Running" };
  const server = createServer(async (request, response) => {
    if (request.method === "GET") { response.writeHead(405).end(); return; }
    if (request.method === "DELETE") { response.writeHead(204).end(); return; }
    let body = "";
    for await (const chunk of request) body += chunk;
    const rpc = JSON.parse(body);
    requests.push({ method: rpc.method, run: request.headers["sylvan-agent-run"], name: rpc.params?.name, args: rpc.params?.arguments });
    if (rpc.id === undefined) { response.writeHead(202).end(); return; }
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Mcp-Session-Id", "fixture-mcp-session");
    const data = rpc.params?.name === "list_agent_sessions" ? [{ id: "native-child", cwd: "/project", status: "idle" }]
      : rpc.params?.name === "list_leafs" ? [{ id: "leaf-1", projectId: "project-1", title: "Example", description: null, status: 2, dueDate: "2030-01-01T12:00:00Z", parentLeafId: null, associations: [] }]
      : rpc.params?.name === "list_root_shells" ? [rootShellResponse]
      : rpc.params?.name === "create_root_shell" ? rootShellResponse
      : rpc.params?.name === "send_root_command" ? rootCommandResponse
      : { sessionId: "native-child", text: "assistant reply", ...(rpc.params?.name === "sub_agent" ? {} : { spaceId: "destination-space" }) };
    const result = rpc.method === "initialize" ? {
      protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "0.1.0" },
    } : Array.isArray(data) ? { content: [{ type: "text", text: JSON.stringify(data) }], isError: false }
      : { content: [{ type: "text", text: "assistant reply" }], structuredContent: data, isError: false };
    response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  process.env.SYLVAN_MCP_URL = `http://127.0.0.1:${address.port}/api/v1/mcp`;
  process.env.SYLVAN_AGENT_RUN_ID = "fixture-run";
  const tools = new Map<string, any>();
  let shutdown: (() => Promise<void>) | undefined;
  try {
    registerSylvan({ registerTool: (tool: { name: string }) => tools.set(tool.name, tool), on: (_event: string, handler: () => Promise<void>) => { shutdown = handler; } } as unknown as ExtensionAPI);
    assert.deepEqual([...tools.keys()].sort(), ["create_agent_session", "create_dev_shell", "create_root_shell", "create_space", "list_agent_sessions", "list_dev_shells", "list_leafs", "list_root_shells", "list_spaces", "send_agent_message", "send_command", "send_root_command", "sub_agent"]);
    const tool = tools.get("sub_agent");
    assert.deepEqual(Object.keys(tool.parameters.properties), ["message"]);
    assert.deepEqual(await tool.execute("fixture-tool-call", { message: "task" }, undefined), {
      content: [{ type: "text", text: "assistant reply" }], details: { sessionId: "native-child" },
    });
    assert.equal(requests.find(request => request.method === "initialize")?.run, "fixture-run");
    assert.equal(requests.find(request => request.method === "tools/call")?.run, "fixture-run");
    assert.equal(requests.filter(request => request.method === "tools/call").length, 1);
    const leafs = tools.get("list_leafs");
    assert.deepEqual(Object.keys(leafs.parameters.properties), ["status"]);
    assert.match(leafs.description, /canonical title-case status name exactly as listed/);
    assert.match(leafs.parameters.properties.status.description, /canonical title-case status name exactly as listed/);
    assert.equal(leafs.parameters.additionalProperties, false);
    assert.equal(leafs.parameters.required?.includes("status") ?? false, false);
    assert.deepEqual(leafs.parameters.properties.status.anyOf.map((item: { const: string }) => item.const), ["Backlog", "Pending", "Doing", "Done", "Closed"]);
    const allLeafs = await leafs.execute("leafs-all", {});
    assert.deepEqual(JSON.parse(allLeafs.content[0].text), [{ id: "leaf-1", projectId: "project-1", title: "Example", description: null, status: 2, dueDate: "2030-01-01T12:00:00Z", parentLeafId: null, associations: [] }]);
    const filteredLeafs = await leafs.execute("leafs-filtered", { status: "Doing" });
    assert.deepEqual(JSON.parse(filteredLeafs.content[0].text), JSON.parse(allLeafs.content[0].text));
    assert.deepEqual(requests.filter(request => request.name === "list_leafs").map(request => request.args), [{}, { status: "Doing" }]);
    const create = tools.get("create_agent_session"); const send = tools.get("send_agent_message");
    assert.deepEqual(Object.keys(create.parameters.properties), ["spaceId", "message"]);
    assert.deepEqual(Object.keys(send.parameters.properties), ["spaceId", "sessionId", "message"]);
    for (const item of [create, send, tools.get("list_agent_sessions")]) assert.equal(item.parameters.additionalProperties, false);
    const created = await create.execute("create-call", { spaceId: "destination-space", message: "initial" });
    assert.deepEqual(JSON.parse(created.content[0].text), { spaceId: "destination-space", sessionId: "native-child", text: "assistant reply" });
    assert.deepEqual(await send.execute("send-call", { spaceId: "destination-space", sessionId: "native-child", message: "follow-up" }), {
      content: [{ type: "text", text: "assistant reply" }], details: { spaceId: "destination-space", sessionId: "native-child" },
    });
    const listed = await tools.get("list_agent_sessions").execute("list-call", { spaceId: "destination-space" });
    assert.deepEqual(JSON.parse(listed.content[0].text), [{ id: "native-child", cwd: "/project", status: "idle" }]);
    assert.deepEqual(requests.find(request => request.name === "list_agent_sessions")?.args, { spaceId: "destination-space" });
    const listRoots = tools.get("list_root_shells");
    const createRoot = tools.get("create_root_shell");
    const sendRoot = tools.get("send_root_command");
    assert.deepEqual(Object.keys(listRoots.parameters.properties), ["spaceId"]);
    assert.deepEqual(Object.keys(createRoot.parameters.properties), ["spaceId"]);
    assert.deepEqual(Object.keys(sendRoot.parameters.properties), ["shellId", "command"]);
    for (const rootTool of [listRoots, createRoot, sendRoot]) {
      assert.equal(rootTool.parameters.additionalProperties, false);
      assert.equal(Object.hasOwn(rootTool.parameters.properties, "user"), false);
      assert.match(rootTool.description, /live Sylvan-launched caller/);
      assert.match(rootTool.description, /permittedSpaces and permittedRootSpaces/);
      assert.match(rootTool.description, /owned by this MCP session|owned Root Shells/);
      assert.match(rootTool.description, /cooperative MCP policy, not a sandbox/);
    }
    assert.deepEqual(listRoots.parameters.required, ["spaceId"]);
    assert.deepEqual(createRoot.parameters.required, ["spaceId"]);
    assert.deepEqual(sendRoot.parameters.required, ["shellId", "command"]);
    assert.match(sendRoot.description, /Developer Shells cannot be used/);

    const rootList = await listRoots.execute("root-list", { spaceId: "destination-space" });
    assert.deepEqual(JSON.parse(rootList.content[0].text), [rootShellResponse]);
    assert.deepEqual(rootList.details, [rootShellResponse]);
    const createdRoot = await createRoot.execute("root-create", { spaceId: "destination-space" });
    assert.deepEqual(JSON.parse(createdRoot.content[0].text), rootShellResponse);
    assert.deepEqual(createdRoot.details, rootShellResponse);
    const rootCommand = await sendRoot.execute("root-command", { shellId: "root-shell", command: "fixture-command" });
    assert.deepEqual(JSON.parse(rootCommand.content[0].text), rootCommandResponse);
    assert.deepEqual(rootCommand.details, rootCommandResponse);
    assert.deepEqual(requests.filter(request => ["list_root_shells", "create_root_shell", "send_root_command"].includes(request.name ?? "")).map(request => request.args), [
      { spaceId: "destination-space" }, { spaceId: "destination-space" }, { shellId: "root-shell", command: "fixture-command" },
    ]);
    assert.equal(requests.filter(request => request.method === "initialize").length, 1);
    assert.equal(requests.filter(request => request.method === "tools/call").length, 9);
  } finally {
    await shutdown?.();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (originalUrl === undefined) delete process.env.SYLVAN_MCP_URL; else process.env.SYLVAN_MCP_URL = originalUrl;
    if (originalRun === undefined) delete process.env.SYLVAN_AGENT_RUN_ID; else process.env.SYLVAN_AGENT_RUN_ID = originalRun;
  }
});
