# pi-sylvan

A thin Pi package that exposes Sylvan's MCP tools to a Pi coding agent.

## Installation

```bash
pi install https://github.com/lightwrath/pi-sylvan.git
```

The package is installed automatically by Sylvan when the PiAgent Space feature is enabled.

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

- `list_spaces`
- `create_space`
- `list_dev_shells`
- `create_dev_shell`
- `send_command`

Each Pi/MCP session owns only the Developer Shells that it creates. Shell command output is limited to the last 50 KB.

The extension creates its MCP connection lazily and terminates the MCP session during Pi's `session_shutdown` lifecycle event. A hard process crash can leave the server-side Shells until they exit or Sylvan restarts.
