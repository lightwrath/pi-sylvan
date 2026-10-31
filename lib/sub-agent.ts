import { randomUUID } from "node:crypto";

type Call = (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
type Operation = "sub_agent" | "create_agent_session" | "send_agent_message";
type Params = { message: string; spaceId?: string; sessionId?: string };

export function createSubAgentExecutor(call: Call) {
  return createAgentMessageExecutor(call, "sub_agent");
}

/** Request identity covers the operation, destination and message, including uncertain observation retries. */
export function createAgentMessageExecutor(call: Call, operation: Operation) {
  const accepted = new Map<string, { fingerprint: string; args: Record<string, unknown> }>();
  return async (toolCallId: string, params: Params, signal?: AbortSignal) => {
    if (!process.env.SYLVAN_AGENT_RUN_ID?.trim()) {
      throw new Error("Agent messaging requires a Pi process launched by Sylvan. Open a conversation in the Agents UI.");
    }
    if (!params.message.trim() || params.message.length > 100000) throw new Error("Enter a message of 1–100,000 characters.");
    const allowed = operation === "sub_agent" ? ["message"] : operation === "create_agent_session" ? ["spaceId", "message"] : ["spaceId", "sessionId", "message"];
    if (Object.keys(params).some(key => !allowed.includes(key))) throw new Error("Configuration, credentials and unsupported agent parameters are not accepted.");
    if (operation !== "sub_agent" && !params.spaceId?.trim()) throw new Error("A destination Space ID is required.");
    if (operation === "send_agent_message" && !params.sessionId?.trim()) throw new Error("An exact native Pi session ID is required.");
    const args = { message: params.message,
      ...(operation === "sub_agent" ? {} : { spaceId: params.spaceId }),
      ...(operation === "send_agent_message" ? { sessionId: params.sessionId } : {}),
    };
    const fingerprint = JSON.stringify({ operation, ...args });
    let submission = accepted.get(toolCallId);
    if (submission && submission.fingerprint !== fingerprint) throw new Error("This tool invocation was already used for a different message or destination.");
    if (!submission) {
      if (accepted.size >= 128) throw new Error("This Pi invocation has reached its agent request limit.");
      submission = { fingerprint, args: { ...args, requestId: randomUUID() } };
      accepted.set(toolCallId, submission);
    }
    const result = await call(operation, submission.args, signal);
    if (!result || typeof result !== "object" || !("text" in result) || typeof result.text !== "string"
      || !("sessionId" in result) || typeof result.sessionId !== "string"
      || (operation !== "sub_agent" && (!("spaceId" in result) || typeof result.spaceId !== "string"))) {
      throw new Error("Invalid sub-agent response. Inspect its conversation in the Agents UI before retrying.");
    }
    const spaceId = "spaceId" in result && typeof result.spaceId === "string" ? result.spaceId : undefined;
    const details = { sessionId: result.sessionId, ...(spaceId ? { spaceId } : {}) };
    // Creation must expose the new ID to the model; continuations return only the new assistant text.
    const text = operation === "create_agent_session" ? JSON.stringify({ ...details, text: result.text }, null, 2) : result.text;
    return { content: [{ type: "text" as const, text }], details };
  };
}
