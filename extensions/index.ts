import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

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
    const transport = new StreamableHTTPClientTransport(url);
    await client.connect(transport, { signal });
    return new SylvanMcpConnection(client, transport);
  }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<JsonValue> {
    const result = await this.client.callTool({ name, arguments: args }, undefined, { signal }) as McpResult;
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

  pi.registerTool({
    name: "list_spaces",
    label: "List Sylvan Spaces",
    description: "List all Sylvan Spaces and their lifecycle status. Poll this after creating a Space until it is Running.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      const result = await call("list_spaces", {}, signal);
      return { content: [{ type: "text", text: toolText(result) }], details: result };
    },
  });

  pi.registerTool({
    name: "create_space",
    label: "Create Sylvan Space",
    description: "Create an Arch Sylvan Space. Provisioning is asynchronous; poll list_spaces until it is Running.",
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
    description: "List active Developer Shells owned by this Pi session for one Space.",
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
    description: "Create a new Developer Shell owned by this Pi session in a running Space.",
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
    description: "Send a command to a Developer Shell owned by this Pi session. Command output is limited to the last 50 KB.",
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
