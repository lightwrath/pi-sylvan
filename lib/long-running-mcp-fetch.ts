import { Agent, fetch as undiciFetch } from "undici";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

export const LONG_RUNNING_AGENT_TOOLS = ["sub_agent", "create_agent_session", "send_agent_message"] as const;
export const AGENT_TOOL_TIMEOUT_ENV = "SYLVAN_MCP_TOOL_TIMEOUT_MS";
export const DEFAULT_AGENT_TOOL_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const MIN_AGENT_TOOL_TIMEOUT_MS = 1_000;
export const MAX_AGENT_TOOL_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const AGENT_HTTP_TIMEOUT_GRACE_MS = 60_000;

type RpcRequestId = string | number;
type McpRequestBody = {
  id?: unknown;
  method?: unknown;
  params?: { name?: unknown; requestId?: unknown };
};

const longRunningTools = new Set<string>(LONG_RUNNING_AGENT_TOOLS);

/** Parse one optional, bounded timeout shared by the MCP SDK request timer and HTTP dispatcher. */
export function parseAgentToolTimeoutMs(value = process.env[AGENT_TOOL_TIMEOUT_ENV]): number {
  if (value === undefined || value.trim() === "") return DEFAULT_AGENT_TOOL_TIMEOUT_MS;

  const text = value.trim();
  const parsed = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(parsed)
    || parsed < MIN_AGENT_TOOL_TIMEOUT_MS || parsed > MAX_AGENT_TOOL_TIMEOUT_MS) {
    throw new Error(`${AGENT_TOOL_TIMEOUT_ENV} must be an integer from ${MIN_AGENT_TOOL_TIMEOUT_MS} through ${MAX_AGENT_TOOL_TIMEOUT_MS} milliseconds (maximum 24 hours).`);
  }

  return parsed;
}

export function isLongRunningAgentTool(name: string): boolean {
  return longRunningTools.has(name);
}

/**
 * Give inference POSTs a bounded Undici timeout and bridge MCP's per-request cancellation
 * notification to that POST's AbortController. The transport's own signal remains session-wide.
 */
export function createLongRunningMcpFetch(
  timeoutMs = DEFAULT_AGENT_TOOL_TIMEOUT_MS,
  timeoutGraceMs = AGENT_HTTP_TIMEOUT_GRACE_MS,
): { fetch: FetchLike; close: () => Promise<void> } {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_AGENT_TOOL_TIMEOUT_MS) {
    throw new RangeError(`Agent HTTP timeout must be from 1 through ${MAX_AGENT_TOOL_TIMEOUT_MS} milliseconds.`);
  }
  if (!Number.isSafeInteger(timeoutGraceMs) || timeoutGraceMs < 0) {
    throw new RangeError("Agent HTTP timeout grace must be a non-negative integer.");
  }

  const httpTimeoutMs = timeoutMs + timeoutGraceMs;
  const agent = new Agent({ headersTimeout: httpTimeoutMs, bodyTimeout: httpTimeoutMs });
  const pending = new Map<RpcRequestId, Set<AbortController>>();
  let closePromise: Promise<void> | undefined;

  const fetch: FetchLike = async (url, init) => {
    const message = parseMcpRequest(init);
    const cancelledRequestId = message?.method === "notifications/cancelled"
      && isRpcRequestId(message.params?.requestId) ? message.params.requestId : undefined;
    if (cancelledRequestId !== undefined) {
      for (const controller of pending.get(cancelledRequestId) ?? []) controller.abort();
      return globalThis.fetch(url, init);
    }

    const requestId = message && isLongRunningAgentRequest(message) && isRpcRequestId(message.id)
      ? message.id : undefined;
    if (requestId === undefined) return globalThis.fetch(url, init);

    const controller = new AbortController();
    const controllers = pending.get(requestId) ?? new Set<AbortController>();
    controllers.add(controller);
    pending.set(requestId, controllers);

    const transportSignal = init?.signal ?? undefined;
    const abortFromTransport = () => controller.abort(transportSignal?.reason);
    if (transportSignal?.aborted) abortFromTransport();
    else transportSignal?.addEventListener("abort", abortFromTransport, { once: true });

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      transportSignal?.removeEventListener("abort", abortFromTransport);
      controllers.delete(controller);
      if (controllers.size === 0 && pending.get(requestId) === controllers) pending.delete(requestId);
    };

    try {
      const response = await undiciFetch(url, {
        ...init,
        signal: controller.signal,
        dispatcher: agent,
      } as Parameters<typeof undiciFetch>[1]) as unknown as Response;
      return trackResponseBody(response, controller, cleanup);
    } catch (error) {
      cleanup();
      throw error;
    }
  };

  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      for (const controllers of pending.values()) {
        for (const controller of controllers) controller.abort();
      }
      await agent.close();
    })();
    return closePromise;
  };

  return { fetch, close };
}

function parseMcpRequest(init?: RequestInit): McpRequestBody | undefined {
  if (init?.method !== "POST" || typeof init.body !== "string") return undefined;
  try {
    return JSON.parse(init.body) as McpRequestBody;
  } catch {
    return undefined;
  }
}

function isLongRunningAgentRequest(message: McpRequestBody): boolean {
  return message.method === "tools/call" && typeof message.params?.name === "string"
    && isLongRunningAgentTool(message.params.name);
}

function isRpcRequestId(value: unknown): value is RpcRequestId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

/** Keep request cancellation attached until the SDK finishes consuming or cancels the body. */
function trackResponseBody(response: Response, requestController: AbortController, cleanup: () => void): Response {
  const body = response.body;
  if (!body) {
    cleanup();
    return response;
  }

  const reader = body.getReader();
  let finished = false;
  let cancelPromise: Promise<void> | undefined;
  const cancelReader = (reason?: unknown): Promise<void> => {
    cancelPromise ??= reader.cancel(reason).then(() => undefined, () => undefined);
    return cancelPromise;
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    requestController.signal.removeEventListener("abort", onAbort);
    cleanup();
  };
  const onAbort = () => {
    void cancelReader(requestController.signal.reason).finally(finish);
  };

  if (requestController.signal.aborted) onAbort();
  else requestController.signal.addEventListener("abort", onAbort, { once: true });

  const trackedBody = new ReadableStream<Uint8Array>({
    async pull(streamController) {
      if (finished) return;
      try {
        const { done, value } = await reader.read();
        if (finished) return;
        if (done) {
          streamController.close();
          finish();
          return;
        }
        streamController.enqueue(value);
      } catch (error) {
        if (!finished) {
          streamController.error(error);
          if (!requestController.signal.aborted) requestController.abort(error);
        }
        finish();
      }
    },
    async cancel(reason) {
      if (!requestController.signal.aborted) requestController.abort(reason);
      await cancelReader(reason);
      finish();
    },
  });

  try {
    return new Response(trackedBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    if (!requestController.signal.aborted) requestController.abort(error);
    void cancelReader(error);
    finish();
    throw error;
  }
}
