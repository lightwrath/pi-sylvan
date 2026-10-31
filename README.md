# pi-sylvan

A thin Pi package that exposes Sylvan's MCP tools to a Pi coding agent.

## Installation

```bash
pi install https://github.com/lightwrath/pi-sylvan.git
```

The package is installed automatically by Sylvan when the PiAgent Space feature is enabled.

### Update an existing Space

You do **not** need to disable/re-enable the PiAgent Space feature or uninstall Pi. When the Space has no active agent runs, open its Developer Shell as **`dev`** and update this package only:

```bash
pi update https://github.com/lightwrath/pi-sylvan.git
```

This command is supported by Pi 1.4.0. It updates the configured Git package from its tracked branch (normally `main`); a configured tag/commit remains pinned. For other Pi versions, check `pi update --help`. `pi update --extensions` updates all extension packages, whereas bare `pi update` updates Pi itself in current versions.

**Preserve local modifications first.** Pi treats its managed Git checkout as disposable: an update to a new commit can hard-reset tracked files and clean untracked files, then reinstall dependencies. Back up/reconcile any custom code or modified package-lock **outside** the managed checkout before updating. Do not run it blindly on a development-patched installation. Auth/settings/session files outside the package checkout are not package contents; do not remove or overwrite them.

New Sylvan agent invocations load the updated extension automatically. Existing terminal Pi processes must be restarted or explicitly reloaded while idle; a Sylvan backend restart alone does not update the installed package. Updating the extension does not deploy the Sylvan backend/migration; deploy the matching server checkpoint separately. Space settings currently provide install/uninstall rather than a dedicated extension-update action.

## Configuration

The default endpoint is:

```text
http://host.containers.internal:4007/api/v1/mcp
```

Override it when Podman cannot resolve the host alias, or when Sylvan is running elsewhere:

```bash
export SYLVAN_MCP_URL=http://192.168.1.10:4007/api/v1/mcp
```

`localhost` inside a Space refers to the Space container, not the host. Podman host-gateway mapping, the host LAN address, or host networking are alternatives when `host.containers.internal` is unavailable.

Sylvan is unauthenticated and intended for a trusted LAN only. Do not expose the MCP endpoint publicly.

## Tools

The extension registers:

- `sub_agent` — send `{ message }` to a fresh, saved Pi conversation on this Sylvan-launched process's Space and working directory. Waits for the child process to exit and returns only completed assistant text (not thinking, tool calls, or tool results). Both native conversations appear in Sylvan's Agents UI. The child uses the Space's native Pi configuration and a fresh context; include all necessary task context in the message. Parent and child share files, so coordinate edits.
- `list_agent_sessions` — `{ spaceId }`: list all native/user sessions across working directories in the account's default `~/.pi/agent/sessions` catalog, with ID, cwd, timestamp, entry count and Sylvan-tracked status (`idle`, `queued`, `running`, `busy`, `deleting`). No transcript or tool-created-session filter. Custom session stores are not discovered; independent Pi processes are not detected.
- `list_leafs` — `{ status? }`: list Leafs across all Projects, optionally filtered using exactly one canonical title-case name: `Backlog`, `Pending`, `Doing`, `Done`, or `Closed`. Omitting `status` includes all five, including `Closed`. Returns each Leaf's `id`, `projectId`, `title`, `description`, numeric `status` (`0=Backlog`, `1=Pending`, `2=Doing`, `3=Done`, `4=Closed`), `dueDate`, `parentLeafId`, and `associations` (`id`, numeric `type`, where `1=Leaf` and `2=Checklist`); ordered by status, due date, then ID. Requires a live Sylvan-launched caller, but Leaf visibility is global and is not restricted by the caller's `permittedSpaces`.
- `create_agent_session` — `{ spaceId, message }`: start a fresh persisted native Pi session in the selected running Pi-enabled Space's registered directory, send its initial message, await exit and return `{ spaceId, sessionId, text }`. The new ID is model-visible for subsequent follow-ups. No empty-session or optional config API. If its HTTP response is lost, inspect recent sessions before submitting a new create.
- `send_agent_message` — `{ spaceId, sessionId, message }`: continue any exact listed native/user session in its saved working directory. Waits for exit and returns only the new assistant text, not old history/thinking/tool output; destination IDs remain in details. Busy/editor-owned/active-or-paused-queue sessions are rejected, never injected into or queued behind an active Pi process. An unrelated busy Space lane also rejects even when the selected session is idle. If its HTTP response is lost, inspect the exact session's status/history before sending another follow-up.
- `list_spaces`
- `create_space`
- `list_dev_shells`
- `create_dev_shell`
- `send_command`

All ten tools require a live Sylvan process binding (`SYLVAN_AGENT_RUN_ID`, sent as the `Sylvan-Agent-Run` initialization header). Space-targeted actions are checked against the new server permission policy; `list_leafs` has no Project/Leaf ACL and returns the global Leaf catalog to any live caller. Sylvan supplies the live run binding to Agents UI processes and their children. An independently launched terminal Pi without that binding cannot use these MCP actions. Each agent's `i` configuration has top-level `permittedSpaces: []` and `permitSpaceCreation: false`, separate from native account-wide settings/auth. Space grants default to deny, including self-access. `list_spaces` is filtered; shell and session actions require the destination UUID in the allowlist, and `sub_agent` requires the caller's own Space UUID. All eligible native/user-created sessions remain addressable within an allowed Space, not only tool-created ones. New child agents inherit both fields; existing destination agents keep their own policy. `create_space` requires the creation flag and automatically adds its new ID to the creator's allowlist. Subsequent actions recheck current policy, including commands on earlier shells and inference request replay; revocation does not kill accepted work. These checks are server-side, not enforced by client-selected policy arguments. The run ID remains coordination metadata, not authentication, and direct REST/ordinary bash are not sandboxed. The permissions checkpoint is deployed, automated-verified and real-model live-accepted in the sibling Sylvan development stack. Configure `Agents:McpUrl` (`Agents__McpUrl`) on Sylvan to pass the intended reachable endpoint as `SYLVAN_MCP_URL`; do not assume the legacy port-4007 default is the development instance.

The raw MCP inference tools require a UUID `requestId`, hidden/generated by the extension. Sylvan deduplicates the same caller/request ID and rejects changed operation or arguments. The extension preserves request identity only for a repeated invocation with the **same Pi tool-call ID**. A fresh tool-call ID always gets a new request ID, even for identical arguments; overlapping identical calls are independent and may start duplicate work. There is no automatic inference retry. If an HTTP response is lost or the call is cancelled/times out, the outcome is unknown: the operation may have reached Sylvan, may still be running, or may already have completed. Inspect `list_agent_sessions`/the Agents UI or the exact session history before submitting a fresh call, which may duplicate the operation.

For Sylvan-launched agents, configure **`Agents:McpToolTimeoutMs`** (environment variable `Agents__McpToolTimeoutMs`) on the Sylvan server. The server validates the integer range **1,000–86,400,000 ms** and passes it to Pi as `SYLVAN_MCP_TOOL_TIMEOUT_MS`; the default is **86,400,000 ms (24 hours)**. That value controls the MCP SDK wait and the Undici HTTP timeout for `sub_agent`, `create_agent_session`, and `send_agent_message`. The HTTP header/body inactivity timeout is the configured value plus 60 seconds, allowing the SDK deadline to expire first. This explicit Undici timeout is necessary because Node's built-in fetch otherwise uses a 300-second default response-header timeout, while the MCP endpoint returns no headers until the agent exits. The direct Undici dependency remains on v6 (Node 18.17+); the documented current Pi 1.4.0 runtime requires Node 22.19+, so the dependency does not raise Pi's existing runtime floor. Long-running requests use a dedicated Undici Agent and therefore do not inherit a globally configured fetch dispatcher/proxy; configure routing explicitly if the MCP endpoint depends on one. For a separately launched Pi client, `SYLVAN_MCP_TOOL_TIMEOUT_MS` can be set directly. This client setting cannot override an earlier timeout imposed by an external proxy or network intermediary; deployments using one must configure its response/idle timeout accordingly.

Current server limits are three child nesting levels, eight concurrent children per Space, 128 submissions per parent invocation, 100,000 input characters, and 1,000,000 returned assistant characters (overflow fails instead of silently truncating). Session discovery retains Sylvan's existing default native session-directory scope.

Configuration/settings/auth arguments are not accepted by the agent tools. The destination uses its native account configuration; no credential copying or Space startup occurs. An agent can use command-line tools in its own Space to configure things when necessary. Agents share account/filesystem privileges, not a sandbox. Ordinary native-file operations retain their FIFO: a child reuses only its own ancestor's lane, otherwise it must acquire an idle destination lane without waiting, preventing unrelated cross-Space wait cycles.

Development tests: `npm ci`, then `npm test` (Node with native TypeScript support). Pi and TypeBox are host-provided peers at runtime, not bundled copies.

Each Pi/MCP session owns only the Developer Shells that it creates. Shell command output is limited to the last 50 KB.

The extension creates its MCP connection lazily and terminates the MCP session during Pi's `session_shutdown` lifecycle event. A hard process crash can leave the server-side Shells until they exit or Sylvan restarts.
