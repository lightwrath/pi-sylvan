import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createAgentMessageExecutor, createSubAgentExecutor } from "../lib/sub-agent.ts";

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

  private constructor(client: Client, transport: StreamableHTTPClientTransport) {
    this.client = client;
    this.transport = transport;
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
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: runId ? { headers: { "Sylvan-Agent-Run": runId } } : undefined,
    });
    await client.connect(transport, { signal });
    return new SylvanMcpConnection(client, transport);
  }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<JsonValue> {
    const result = await this.client.callTool({ name, arguments: args }, undefined, {
      signal,
      // Delegation can involve many model/tool turns; the SDK's default is only 60 seconds.
      timeout: ["sub_agent", "create_agent_session", "send_agent_message"].includes(name) ? 24 * 60 * 60 * 1000 : undefined,
    }) as McpResult;
    if (result.isError) {
      throw new Error(readText(result) || `Sylvan MCP tool '${name}' failed.`);
    }

    return result.structuredContent ?? parseTextResult(result);
  }

  async close(): Promise<void> {
    try {
      await this.transport.terminateSession();
    } finally {
      await this.client.close();
    }
  }

  private get sessionId(): string | undefined {
    return this.transport.sessionId;
  }
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
  ): Promise<JsonValue> => (await getConnection(signal)).call(name, args, signal);

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
    description: "Send a message to a fresh saved Pi sub-agent on this agent's Sylvan Space and working directory. Waits for process exit and returns only assistant text, not thinking, tool calls, or tool results. Both conversations are visible in Sylvan's Agents UI. The child uses the Space's native Pi configuration and does not inherit this conversation. Requires this Pi process to have been launched by Sylvan and its own Space in permittedSpaces. The new child inherits permittedSpaces and permitSpaceCreation. Cancellation stops observation, not the child; inspect its conversation before retrying uncertain work. Parent and child share files, so coordinate edits.",
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
    name: "create_agent_session",
    label: "Create Agent Session",
    description: "Create a fresh saved Pi conversation on a permitted running Space and send its first message. The new agent inherits permittedSpaces and permitSpaceCreation. Waits for process exit and returns spaceId, sessionId and assistant text; use the returned ID with send_agent_message. Uses destination native settings/auth, with no config or credential parameters. Requires a Sylvan-launched caller. Busy unrelated Space lanes fail rather than queue. Cancellation ends observation, not inference; inspect saved sessions before retrying uncertain tasks.",
    parameters: Type.Object({
      spaceId: Type.String({ description: "The destination Space ID." }),
      message: Type.String({ minLength: 1, maxLength: 100000, description: "The complete initial task/message for a fresh context." }),
    }, { additionalProperties: false }),
    execute: createAgentMessageExecutor(call, "create_agent_session"),
  });

  pi.registerTool({
    name: "send_agent_message",
    label: "Send Agent Message",
    description: "Send a follow-up to any exact listed native Pi session on the selected Space, preserving its history and using its recorded working directory. Resumes an idle session in a new process; it does not inject into an active process. Waits for completion and returns only new assistant text, not old history/thinking/tool output. Busy/editing/queued sessions and unrelated busy Space lanes fail rather than queue. Requires a Sylvan-launched caller and the destination in permittedSpaces. Existing destination agents keep their own permissions; all native sessions within an allowed Space remain addressable. Cancellation ends observation, not inference; inspect the target before retrying uncertain work.",
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
    description: "Create an Arch Sylvan Space when this agent's permitSpaceCreation is true. Its ID is automatically added to the caller's permittedSpaces. Provisioning is asynchronous; poll list_spaces until it is Running.",
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
    description: "Send a command to a Developer Shell owned by this Pi session. Requires current permission for its Space and a live Sylvan caller, even for shells created earlier. Command output is limited to the last 50 KB.",
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
}
