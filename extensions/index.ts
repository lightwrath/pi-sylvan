import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AgentCallOutcomeUnknownError, createAgentMessageExecutor, createSubAgentExecutor } from "../lib/sub-agent.ts";
import { createLongRunningMcpFetch, isLongRunningAgentTool, parseAgentToolTimeoutMs } from "../lib/long-running-mcp-fetch.ts";

const DEFAULT_MCP_URL = "http://host.containers.internal:4007/api/v1/mcp";
const MAX_OUTPUT_BYTES = 50 * 1024;

type JsonValue = unknown;

type McpResult = {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

class SylvanMcpConnection {
  private readonly client: Client;
  private readonly transport: StreamableHTTPClientTransport;
  private readonly agentToolTimeoutMs: number;
  private readonly closeLongRunningFetch: () => Promise<void>;

  private constructor(
    client: Client,
    transport: StreamableHTTPClientTransport,
    agentToolTimeoutMs: number,
    closeLongRunningFetch: () => Promise<void>,
  ) {
    this.client = client;
    this.transport = transport;
    this.agentToolTimeoutMs = agentToolTimeoutMs;
    this.closeLongRunningFetch = closeLongRunningFetch;
  }

  static async connect(signal?: AbortSignal): Promise<SylvanMcpConnection> {
    const endpoint = process.env.SYLVAN_MCP_URL?.trim() || DEFAULT_MCP_URL;
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new Error(`SYLVAN_MCP_URL is not a valid URL: ${endpoint}`);
    }

    const client = new Client(
      { name: "pi-sylvan", version: "0.1.0" },
      { capabilities: {} },
    );
    const runId = process.env.SYLVAN_AGENT_RUN_ID?.trim();
    const agentToolTimeoutMs = parseAgentToolTimeoutMs();
    const longRunningFetch = createLongRunningMcpFetch(agentToolTimeoutMs);
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: runId ? { headers: { "Sylvan-Agent-Run": runId } } : undefined,
      fetch: longRunningFetch.fetch,
    });
    try {
      await client.connect(transport, { signal });
    } catch (error) {
      await client.close().catch(() => undefined);
      await longRunningFetch.close().catch(() => undefined);
      throw error;
    }
    return new SylvanMcpConnection(client, transport, agentToolTimeoutMs, longRunningFetch.close);
  }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<JsonValue> {
    signal?.throwIfAborted();
    let result: McpResult;
    try {
      result = await this.client.callTool({ name, arguments: args }, undefined, {
        signal,
        // The SDK default is 60 seconds. Keep its deadline just inside Undici's HTTP deadline.
        timeout: isLongRunningAgentTool(name) ? this.agentToolTimeoutMs : undefined,
      }) as McpResult;
    } catch (error) {
      // Any rejected tools/call response is ambiguous: the request may have reached Sylvan
      // even when the HTTP status, body or protocol response is invalid.
      if (isLongRunningAgentTool(name)) {
        throw new AgentCallOutcomeUnknownError(uncertainAgentCallMessage(name), error);
      }
      throw error;
    }
    if (result.isError) {
      throw new Error(readText(result) || `Sylvan MCP tool '${name}' failed.`);
    }

    return result.structuredContent ?? parseTextResult(result);
  }

  async close(): Promise<void> {
    try {
      await this.transport.terminateSession();
    } finally {
      try {
        await this.client.close();
      } finally {
        await this.closeLongRunningFetch();
      }
    }
  }

  private get sessionId(): string | undefined {
    return this.transport.sessionId;
  }
}

function uncertainAgentCallMessage(name: string): string {
  const recovery = name === "create_agent_session"
    ? "Inspect recent sessions in the destination Space with list_agent_sessions before submitting another create."
    : name === "send_agent_message"
      ? "Check the exact session's status and history in the Agents UI before sending another follow-up."
      : "Inspect the Agents UI or session list before starting a replacement child.";
  return `The outcome of '${name}' is unknown: the request may have reached Sylvan and the agent may still be running or may already have completed. An HTTP error, timeout, cancellation, or invalid response does not prove the operation failed before starting. No automatic retry was made. ${recovery} A fresh tool call gets a new request ID and may duplicate the operation; inspect first.`;
}

function readText(result: McpResult): string {
  return result.content
    ?.filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n")
    .trim() ?? "";
}

function parseTextResult(result: McpResult): JsonValue {
  const text = readText(result);
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return text;
  }
}

function truncateTail(value: string, maximumBytes: number): { value: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maximumBytes) {
    return { value, truncated: false };
  }

  return {
    value: new TextDecoder().decode(bytes.slice(bytes.byteLength - maximumBytes)),
    truncated: true,
  };
}

function toolText(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function normalizeCommandResult(value: JsonValue): JsonValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const result = { ...(value as Record<string, unknown>) };
  if (typeof result.output === "string") {
    const output = truncateTail(result.output, MAX_OUTPUT_BYTES);
    result.output = output.value;
    result.truncated = Boolean(result.truncated) || output.truncated;
  }

  return result;
}

export default function registerSylvan(pi: ExtensionAPI) {
  let connection: SylvanMcpConnection | undefined;
  let connectionPromise: Promise<SylvanMcpConnection> | undefined;

  const getConnection = (signal?: AbortSignal): Promise<SylvanMcpConnection> => {
    if (connection) {
      return Promise.resolve(connection);
    }

    connectionPromise ??= SylvanMcpConnection.connect(signal).then((connected) => {
      connection = connected;
      return connected;
    }).finally(() => {
      connectionPromise = undefined;
    });
    return connectionPromise;
  };

  const call = async (
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<JsonValue> => {
    signal?.throwIfAborted();
    return (await getConnection(signal)).call(name, args, signal);
  };

  pi.on("session_shutdown", async () => {
    const current = connection;
    connection = undefined;
    connectionPromise = undefined;
    if (current) {
      await current.close();
    }
  });

  const executeSubAgent = createSubAgentExecutor(call);
  pi.registerTool({
    name: "sub_agent",
    label: "Sylvan Sub-agent",
    description: "Send a message to a fresh saved Pi sub-agent on this agent's Sylvan Space and working directory. Waits for process exit and returns only assistant text, not thinking, tool calls, or tool results. Both conversations are visible in Sylvan's Agents UI. The child uses the Space's native Pi configuration and does not inherit this conversation. Requires this Pi process to have been launched by Sylvan and its own Space in permittedSpaces. The new child inherits permittedSpaces, permittedRootSpaces and permitSpaceCreation. Cancellation or a lost HTTP response stops observation, not the child; inspect its saved conversation before starting a replacement. Only a repeated invocation with the same Pi tool-call ID reuses its request ID; a fresh tool-call ID gets a new request ID and may duplicate the operation. Parent and child share files, so coordinate edits.",
    parameters: Type.Object({
      message: Type.String({ minLength: 1, maxLength: 100000, description: "The complete task/message for the sub-agent's fresh context." }),
    }),
    execute: executeSubAgent,
  });

  pi.registerTool({
    name: "list_agent_sessions",
    label: "List Agent Sessions",
    description: "List all sessions across working directories in a permitted running Pi-enabled Space account's default native Pi catalog, including user-created sessions. Requires a live Sylvan caller. Custom --session-dir stores are not discoverable. Returns IDs, timestamps, entry counts and Sylvan-tracked status (idle/queued/running/busy/deleting), not transcripts. Independent Pi processes are not tracked; an idle session may still have a busy Space lane.",
    parameters: Type.Object({ spaceId: Type.String({ description: "The destination Space ID." }) }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal) {
      const result = await call("list_agent_sessions", { spaceId: params.spaceId }, signal);
      return { content: [{ type: "text", text: toolText(result) }], details: result };
    },
  });

  pi.registerTool({
    name: "list_leafs",
    label: "List Leafs",
    description: "List Leafs across all Projects. With no status, includes Backlog, Pending, Doing, Done and Closed. Optionally filter using one canonical title-case status name exactly as listed: Backlog, Pending, Doing, Done or Closed. Returns a JSON array with id, projectId, title, description, numeric status (0=Backlog, 1=Pending, 2=Doing, 3=Done, 4=Closed), dueDate, parentLeafId and associations [{ id, type }], where association type is numeric (1=Leaf, 2=Checklist), ordered by status, due date and ID. Requires a live Sylvan caller; Leafs are global and are not filtered by permittedSpaces.",
    parameters: Type.Object({
      status: Type.Optional(Type.Union([
        Type.Literal("Backlog"),
        Type.Literal("Pending"),
        Type.Literal("Doing"),
        Type.Literal("Done"),
        Type.Literal("Closed"),
      ], { description: "Use one canonical title-case status name exactly as listed; omit to include all statuses, including Closed." })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal) {
      const args = params.status === undefined ? {} : { status: params.status };
      const result = await call("list_leafs", args, signal);
      return { content: [{ type: "text", text: toolText(result) }], details: result };
    },
  });

  pi.registerTool({
    name: "create_agent_session",
    label: "Create Agent Session",
    description: "Create a fresh saved Pi conversation on a permitted running Space and send its first message. The new agent inherits permittedSpaces, permittedRootSpaces and permitSpaceCreation. Waits for process exit and returns spaceId, sessionId and assistant text; use the returned ID with send_agent_message. Uses destination native settings/auth, with no config or credential parameters. Requires a Sylvan-launched caller. Busy unrelated Space lanes fail rather than queue. Cancellation or a lost HTTP response ends observation, not inference. Inspect recent sessions with list_agent_sessions before submitting a new create; a fresh tool-call ID gets a new request ID and may duplicate work.",
    parameters: Type.Object({
      spaceId: Type.String({ description: "The destination Space ID." }),
      message: Type.String({ minLength: 1, maxLength: 100000, description: "The complete initial task/message for a fresh context." }),
    }, { additionalProperties: false }),
    execute: createAgentMessageExecutor(call, "create_agent_session"),
  });

  pi.registerTool({
    name: "send_agent_message",
    label: "Send Agent Message",
    description: "Send a follow-up to any exact listed native Pi session on the selected Space, preserving its history and using its recorded working directory. Resumes an idle session in a new process; it does not inject into an active process. Waits for completion and returns only new assistant text, not old history/thinking/tool output. Busy/editing/queued sessions and unrelated busy Space lanes fail rather than queue. Requires a Sylvan-launched caller and the destination in permittedSpaces. Existing destination agents keep their own permissions; all native sessions within an allowed Space remain addressable. Cancellation or a lost HTTP response ends observation, not inference. Check the exact session's status/history before sending another follow-up; a fresh tool-call ID gets a new request ID and may duplicate the message.",
    parameters: Type.Object({
      spaceId: Type.String({ description: "The destination Space ID." }),
      sessionId: Type.String({ description: "The exact full native Pi session ID from list_agent_sessions or create_agent_session, not a file path or prefix." }),
      message: Type.String({ minLength: 1, maxLength: 100000, description: "The new message/task for the existing conversation." }),
    }, { additionalProperties: false }),
    execute: createAgentMessageExecutor(call, "send_agent_message"),
  });

  pi.registerTool({
    name: "list_spaces",
    label: "List Sylvan Spaces",
    description: "List only this agent's permitted Sylvan Spaces and their lifecycle status. Requires a live Sylvan caller. Poll this after creating a Space until it is Running.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      const result = await call("list_spaces", {}, signal);
      return { content: [{ type: "text", text: toolText(result) }], details: result };
    },
  });

  pi.registerTool({
    name: "create_space",
    label: "Create Sylvan Space",
    description: "Create an Arch Sylvan Space when this agent's permitSpaceCreation is true. Its ID is automatically added to the caller's permittedSpaces and permittedRootSpaces. Provisioning is asynchronous; poll list_spaces until it is Running.",
    parameters: Type.Object({
      name: Type.String({ description: "Name for the new Space." }),
    }),
    async execute(_toolCallId, params, signal) {
      const result = await call("create_space", { name: params.name }, signal);
      return { content: [{ type: "text", text: toolText(result) }], details: result };
    },
  });

  pi.registerTool({
    name: "list_dev_shells",
    label: "List Owned Developer Shells",
    description: "List active Developer Shells owned by this Pi session for one permitted Space. Requires a live Sylvan caller.",
    parameters: Type.Object({
      spaceId: Type.String({ description: "The Space ID." }),
    }),
    async execute(_toolCallId, params, signal) {
      const result = await call("list_dev_shells", { spaceId: params.spaceId }, signal);
      return { content: [{ type: "text", text: toolText(result) }], details: result };
    },
  });

  pi.registerTool({
    name: "create_dev_shell",
    label: "Create Developer Shell",
    description: "Create a new Developer Shell owned by this Pi session in a permitted running Space. Requires a live Sylvan caller.",
    parameters: Type.Object({
      spaceId: Type.String({ description: "The Space ID." }),
    }),
    async execute(_toolCallId, params, signal) {
      const result = await call("create_dev_shell", { spaceId: params.spaceId }, signal);
      return { content: [{ type: "text", text: toolText(result) }], details: result };
    },
  });

  pi.registerTool({
    name: "send_command",
    label: "Send Sylvan Developer Shell Command",
    description: "Send a command to a Developer Shell owned by this Pi session. Requires current permission for its Space and a live Sylvan caller, even for shells created earlier. Root Shells cannot be used through this tool. Command output is limited to the last 50 KB.",
    parameters: Type.Object({
      shellId: Type.String({ description: "The owned Developer Shell ID." }),
      command: Type.String({ description: "The command to run." }),
    }),
    async execute(_toolCallId, params, signal) {
      const result = normalizeCommandResult(await call(
        "send_command",
        { shellId: params.shellId, command: params.command },
        signal,
      ));
      return { content: [{ type: "text", text: toolText(result) }], details: result };
    },
  });

  pi.registerTool({
    name: "list_root_shells",
    label: "List Owned Root Shells",
    description: "List active Root Shells owned by this MCP session. Requires a live Sylvan-launched caller and the Space in both permittedSpaces and permittedRootSpaces. The server fixes the shell role as Root. This is cooperative MCP policy, not a sandbox or REST authorization boundary.",
    parameters: Type.Object({ spaceId: Type.String({ description: "The Space ID." }) }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal) {
      const result = await call("list_root_shells", { spaceId: params.spaceId }, signal);
      return { content: [{ type: "text", text: toolText(result) }], details: result };
    },
  });

  pi.registerTool({
    name: "create_root_shell",
    label: "Create Root Shell",
    description: "Create a Root Shell owned by this MCP session. Requires a live Sylvan-launched caller and the Space in both permittedSpaces and permittedRootSpaces. The server fixes the shell role as Root; callers cannot select a user or role. This is cooperative MCP policy, not a sandbox or REST authorization boundary.",
    parameters: Type.Object({ spaceId: Type.String({ description: "The Space ID." }) }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal) {
      const result = await call("create_root_shell", { spaceId: params.spaceId }, signal);
      return { content: [{ type: "text", text: toolText(result) }], details: result };
    },
  });

  pi.registerTool({
    name: "send_root_command",
    label: "Send Sylvan Root Shell Command",
    description: "Send a command to a Root Shell owned by this MCP session. Requires a live Sylvan-launched caller; the Space must be in both permittedSpaces and permittedRootSpaces, and both grants are rechecked for every command. Developer Shells cannot be used through this tool. This is cooperative MCP policy, not a sandbox or REST authorization boundary. Command output is limited to the last 50 KB.",
    parameters: Type.Object({
      shellId: Type.String({ description: "The owned Root Shell ID." }),
      command: Type.String({ description: "The command to run with Root Shell privileges inside the Space." }),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal) {
      const result = normalizeCommandResult(await call(
        "send_root_command",
        { shellId: params.shellId, command: params.command },
        signal,
      ));
      return { content: [{ type: "text", text: toolText(result) }], details: result };
    },
  });
}
