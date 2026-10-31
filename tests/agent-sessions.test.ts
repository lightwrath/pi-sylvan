import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { AgentCallOutcomeUnknownError, createAgentMessageExecutor } from "../lib/sub-agent.ts";

const originalRun = process.env.SYLVAN_AGENT_RUN_ID;
afterEach(() => {
  if (originalRun === undefined) delete process.env.SYLVAN_AGENT_RUN_ID;
  else process.env.SYLVAN_AGENT_RUN_ID = originalRun;
});

test("creation exposes the addressable native ID but continuation content is only new assistant text", async () => {
  process.env.SYLVAN_AGENT_RUN_ID = "fixture-run";
  const submitted: Array<{ name: string; args: Record<string, unknown> }> = [];
  const call = async (name: string, args: Record<string, unknown>) => {
    submitted.push({ name, args });
    return { spaceId: "space-b", sessionId: "user-created-native-id", text: "assistant only", history: "PRIVATE_HISTORY", toolOutput: "PRIVATE_TOOL" };
  };
  const created = await createAgentMessageExecutor(call, "create_agent_session")("create-1", { spaceId: "space-b", message: "initial 🐳" });
  assert.deepEqual(JSON.parse(created.content[0].text), { spaceId: "space-b", sessionId: "user-created-native-id", text: "assistant only" });
  const continued = await createAgentMessageExecutor(call, "send_agent_message")("send-1", { spaceId: "space-b", sessionId: "user-created-native-id", message: "follow-up" });
  assert.deepEqual(continued, { content: [{ type: "text", text: "assistant only" }], details: { spaceId: "space-b", sessionId: "user-created-native-id" } });
  assert.deepEqual(submitted.map(item => item.name), ["create_agent_session", "send_agent_message"]);
  assert.deepEqual(Object.keys(submitted[0].args).sort(), ["message", "requestId", "spaceId"]);
  assert.deepEqual(Object.keys(submitted[1].args).sort(), ["message", "requestId", "sessionId", "spaceId"]);
  assert.notEqual(submitted[0].args.requestId, submitted[1].args.requestId);
  assert.doesNotMatch(JSON.stringify([created, continued]), /PRIVATE/);
});

test("the same Pi tool-call ID retains its request ID and cannot be reused for different arguments", async () => {
  process.env.SYLVAN_AGENT_RUN_ID = "fixture-run";
  const submissions: Record<string, unknown>[] = [];
  const execute = createAgentMessageExecutor(async (_name, args) => {
    submissions.push(args);
    if (submissions.length === 1) throw new Error("uncertain observation");
    return { spaceId: "space-b", sessionId: "native-id", text: "reply" };
  }, "send_agent_message");
  const params = { spaceId: "space-b", sessionId: "native-id", message: "task" };
  await assert.rejects(execute("send-1", params), /uncertain/);
  await execute("send-1", params);
  for (const different of [{ ...params, spaceId: "space-c" }, { ...params, sessionId: "another-id" }, { ...params, message: "different" }])
    await assert.rejects(execute("send-1", different), /different message or destination/);
  await execute("send-2", params);
  assert.equal(submissions[0].requestId, submissions[1].requestId);
  assert.notEqual(submissions[1].requestId, submissions[2].requestId);
});

test("a fresh tool-call ID after an uncertain create gets a new request ID", async () => {
  process.env.SYLVAN_AGENT_RUN_ID = "fixture-run";
  const submissions: Record<string, unknown>[] = [];
  const execute = createAgentMessageExecutor(async (_name, args) => {
    submissions.push(args);
    if (submissions.length === 1) throw new AgentCallOutcomeUnknownError("response lost; outcome is unknown");
    return { spaceId: "space-b", sessionId: "native", text: "reply" };
  }, "create_agent_session");
  const params = { spaceId: "space-b", message: "initial" };
  await assert.rejects(execute("create-1", params), /outcome is unknown/);
  await execute("create-2", params);
  assert.notEqual(submissions[0].requestId, submissions[1].requestId);
});

test("overlapping identical calls with distinct Pi tool-call IDs get independent request IDs", async () => {
  process.env.SYLVAN_AGENT_RUN_ID = "fixture-run";
  const submissions: Record<string, unknown>[] = [];
  const resolvers: Array<(value: unknown) => void> = [];
  const execute = createAgentMessageExecutor(async (_name, args) => {
    submissions.push(args);
    return await new Promise(resolve => resolvers.push(resolve));
  }, "create_agent_session");
  const params = { spaceId: "space-b", message: "same task" };
  const first = execute("create-1", params);
  const second = execute("create-2", params);
  assert.equal(submissions.length, 2);
  assert.notEqual(submissions[0].requestId, submissions[1].requestId);
  for (const resolve of resolvers) resolve({ spaceId: "space-b", sessionId: "native", text: "reply" });
  await Promise.all([first, second]);
});

test("remote tools reject missing caller/targets, config, auth and response wrappers without usable destination metadata", async () => {
  let calls = 0;
  const execute = createAgentMessageExecutor(async () => { calls++; return { sessionId: "native", text: "reply" }; }, "send_agent_message");
  const params = { spaceId: "space-b", sessionId: "native-id", message: "task" };
  delete process.env.SYLVAN_AGENT_RUN_ID;
  await assert.rejects(execute("send-1", params), /launched by Sylvan/);
  process.env.SYLVAN_AGENT_RUN_ID = "fixture-run";
  await assert.rejects(execute("no-space", { message: "task", sessionId: "native" }), /Space ID/);
  await assert.rejects(execute("no-session", { spaceId: "space-b", message: "task" }), /session ID/);
  await assert.rejects(execute("config", { ...params, config: {} } as typeof params), /not accepted/);
  await assert.rejects(execute("auth", { ...params, auth: {} } as typeof params), /not accepted/);
  assert.equal(calls, 0);
  await assert.rejects(execute("bad-response", params), /Invalid sub-agent response/);
});
