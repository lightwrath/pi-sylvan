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
- `create_agent_session` — `{ spaceId, message }`: start a fresh persisted native Pi session in the selected running Pi-enabled Space's registered directory, send its initial message, await exit and return `{ spaceId, sessionId, text }`. The new ID is model-visible for subsequent follow-ups. No empty-session or optional config API.
- `send_agent_message` — `{ spaceId, sessionId, message }`: continue any exact listed native/user session in its saved working directory. Waits for exit and returns only the new assistant text, not old history/thinking/tool output; destination IDs remain in details. Busy/editor-owned/active-or-paused-queue sessions are rejected, never injected into or queued behind an active Pi process. An unrelated busy Space lane also rejects even when the selected session is idle.
- `list_spaces`
- `create_space`
- `list_dev_shells`
- `create_dev_shell`
- `send_command`

All nine tools require a live Sylvan process binding (`SYLVAN_AGENT_RUN_ID`, sent as the `Sylvan-Agent-Run` initialization header) under the new server permission policy. Sylvan supplies it to Agents UI processes and their children. An independently launched terminal Pi without that binding cannot use these MCP actions. Each agent's `i` configuration has top-level `permittedSpaces: []` and `permitSpaceCreation: false`, separate from native account-wide settings/auth. Defaults deny, including self-access. `list_spaces` is filtered; shell and session actions require the destination UUID in the allowlist, and `sub_agent` requires the caller's own Space UUID. All eligible native/user-created sessions remain addressable within an allowed Space, not only tool-created ones. New child agents inherit both fields; existing destination agents keep their own policy. `create_space` requires the creation flag and automatically adds its new ID to the creator's allowlist. Subsequent actions recheck current policy, including commands on earlier shells and inference request replay; revocation does not kill accepted work. These checks are server-side, not enforced by client-selected policy arguments. The run ID remains coordination metadata, not authentication, and direct REST/ordinary bash are not sandboxed. The permissions checkpoint is deployed, automated-verified and real-model live-accepted in the sibling Sylvan development stack. Configure `Agents:McpUrl` (`Agents__McpUrl`) on Sylvan to pass the intended reachable endpoint as `SYLVAN_MCP_URL`; do not assume the legacy port-4007 default is the development instance.

The raw MCP inference tools also require a UUID `requestId`; the extension hides/generates it and reuses it for an uncertain retry of the same tool invocation. Identity covers operation, destination and message; changing any of them under the same invocation is rejected. It does not automatically retry inference. Cancellation/timeout ends observation, not the child process: inspect its saved conversation before starting a replacement task. The MCP client permits 24 hours for delegation/creation/continuation. Current server limits are three child nesting levels, eight concurrent children per Space, 128 submissions per parent invocation, 100,000 input characters, and 1,000,000 returned assistant characters (overflow fails instead of silently truncating). Session discovery retains Sylvan's existing default native session-directory scope.

Configuration/settings/auth arguments are not accepted by the agent tools. The destination uses its native account configuration; no credential copying or Space startup occurs. An agent can use command-line tools in its own Space to configure things when necessary. Agents share account/filesystem privileges, not a sandbox. Ordinary native-file operations retain their FIFO: a child reuses only its own ancestor's lane, otherwise it must acquire an idle destination lane without waiting, preventing unrelated cross-Space wait cycles.

Development tests: `npm ci`, then `npm test` (Node with native TypeScript support). Pi and TypeBox are host-provided peers at runtime, not bundled copies.

Each Pi/MCP session owns only the Developer Shells that it creates. Shell command output is limited to the last 50 KB.

The extension creates its MCP connection lazily and terminates the MCP session during Pi's `session_shutdown` lifecycle event. A hard process crash can leave the server-side Shells until they exit or Sylvan restarts.
