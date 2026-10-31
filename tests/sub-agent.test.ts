import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createSubAgentExecutor } from "../lib/sub-agent.ts";

const originalRun = process.env.SYLVAN_AGENT_RUN_ID;
afterEach(() => {
  if (originalRun === undefined) delete process.env.SYLVAN_AGENT_RUN_ID;
  else process.env.SYLVAN_AGENT_RUN_ID = originalRun;
});

test("unbound callers fail before opening a connection", async () => {
  delete process.env.SYLVAN_AGENT_RUN_ID;
  const execute = createSubAgentExecutor(async () => { throw new Error("must not connect"); });
  await assert.rejects(execute("call-1", { message: "task" }), /launched by Sylvan/);
});

test("only assistant text reaches model content, with the native session ID in details", async () => {
  process.env.SYLVAN_AGENT_RUN_ID = "fixture-run";
  const signal = new AbortController().signal;
  const execute = createSubAgentExecutor(async (name, args, actualSignal) => {
    assert.equal(name, "sub_agent");
    assert.deepEqual(Object.keys(args).sort(), ["message", "requestId"]);
    assert.equal(args.message, "task 🐳");
    assert.match(String(args.requestId), /^[0-9a-f-]{36}$/);
    assert.equal(actualSignal, signal);
    return { sessionId: "child", text: "assistant only", toolOutput: "must not appear" };
  });
  assert.deepEqual(await execute("call-1", { message: "task 🐳" }, signal), {
    content: [{ type: "text", text: "assistant only" }], details: { sessionId: "child" },
  });
});

test("uncertain retries keep their request ID; later independent calls use another ID", async () => {
  process.env.SYLVAN_AGENT_RUN_ID = "fixture-run";
  const submissions: unknown[] = [];
  const execute = createSubAgentExecutor(async (_name, args) => {
    submissions.push(args.requestId);
    if (submissions.length === 1) throw new Error("uncertain observation");
    return { sessionId: "child", text: "reply" };
  });
  await assert.rejects(execute("call-1", { message: "task" }), /uncertain/);
  await execute("call-1", { message: "task" });
  await assert.rejects(execute("call-1", { message: "different" }), /different message/);
  await execute("call-2", { message: "task" });
  assert.equal(submissions[0], submissions[1]);
  assert.notEqual(submissions[1], submissions[2]);
});

test("invalid/blank inputs and invalid responses never masquerade as a successful child", async () => {
  process.env.SYLVAN_AGENT_RUN_ID = "fixture-run";
  const execute = createSubAgentExecutor(async () => ({ toolOutput: "not assistant text" }));
  await assert.rejects(execute("blank", { message: "  " }), /Enter a message/);
  await assert.rejects(execute("long", { message: "x".repeat(100001) }), /Enter a message/);
  await assert.rejects(execute("call-1", { message: "task" }), /Invalid sub-agent response/);
});
