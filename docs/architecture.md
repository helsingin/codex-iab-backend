# Architecture

`codex-iab-backend` is a local Browser Use backend for Codex. It is not an MCP server.

## Components

- `src/cli.mjs`: long-running backend process for one Codex session.
- `src/server.mjs`: Unix socket JSON-RPC server under `/tmp/codex-browser-use`.
- `src/backend.mjs`: maps Codex Browser Use methods to browser engine calls.
- `src/chrome-engine.mjs`: launches headless Chrome and drives pages through CDP.
- `src/cdp-connection.mjs`: small WebSocket CDP client.
- `src/framing.mjs`: length-prefixed JSON frame codec used by the Codex browser client.
- `src/session-hook.mjs`: launcher logic used by Codex `SessionStart` hooks.
- `scripts/start-session-backend.mjs`: hook entrypoint in the backend repo.
- `.codex-plugin/plugin.json`: standard Codex plugin manifest.
- `hooks/hooks.json`: standard Codex plugin hook registration.

## Discovery Flow

Codex's Browser plugin uses the `node_repl` browser client. That client discovers IAB-compatible backends by scanning `/tmp/codex-browser-use` for Unix sockets and sending JSON-RPC `getInfo` to each candidate.

The backend must answer:

```json
{
  "type": "iab",
  "name": "Local IAB Backend",
  "metadata": {
    "codexSessionId": "<current Codex session id>",
    "codexAppBuildFlavor": "prod"
  },
  "capabilities": {
    "browser": [],
    "tab": []
  }
}
```

The browser client filters IAB candidates by `metadata.codexSessionId`. That is why the backend is started once per Codex session instead of as one generic global daemon.

## Session Lifecycle

1. Codex starts a new session.
2. Plugin `SessionStart` hook receives JSON on stdin.
3. The hook payload contains `session_id`.
4. The hook command uses `PLUGIN_ROOT` to run `scripts/start-session-backend.mjs`.
5. `scripts/start-session-backend.mjs` starts `src/cli.mjs` with that session id.
6. `src/cli.mjs` creates `/tmp/codex-browser-use/codex-iab-<session-id>.sock`.
7. Browser Use discovery selects that socket for the current session.
8. The backend exits after `CODEX_IAB_IDLE_TIMEOUT_MS` of inactivity when configured.

Hook payload shape observed in local testing:

```json
{
  "session_id": "019f...",
  "transcript_path": "...jsonl",
  "cwd": "...",
  "hook_event_name": "SessionStart",
  "model": "gpt-5.5",
  "permission_mode": "bypassPermissions",
  "source": "startup"
}
```

`src/session-hook.mjs` also supports adjacent payload shapes so the project is not brittle if Codex renames a field.

## Runtime Protocol

The socket protocol is length-prefixed JSON-RPC 2.0. Each frame is:

- 4-byte unsigned integer length, using host endianness to match the Browser plugin client.
- UTF-8 JSON body.

The client sends methods such as:

- `getInfo`
- `getTabs`
- `getUserTabs`
- `createTab`
- `attach`
- `detach`
- `executeCdp`
- `executeUnhandledCommand`

Most tab operations arrive through `executeUnhandledCommand` with a `type` field, for example `navigate_tab_url`, `tab_screenshot`, or `playwright_dom_snapshot`.

## Browser Engine

The backend launches local Chrome with:

- `--remote-debugging-port=0`
- isolated temporary `--user-data-dir`
- headless mode by default
- a 1280x720 viewport

No Playwright package is required. The implementation talks directly to Chrome DevTools Protocol over WebSocket using built-in Node APIs.

## Supported Operations

Current supported path:

- IAB discovery through `getInfo`
- tab create/list/select/close
- tab navigation, reload, back, forward
- title and URL reads
- screenshots
- simple DOM snapshot
- read-only `playwright.evaluate`
- wait-for-load-state, wait-for-url, wait-for-timeout
- limited direct `executeCdp`

## Known Limitations

- Locator click/fill APIs are not fully implemented yet.
- Clipboard, downloads, browser auth, and full DevTools event buffering are not implemented.
- The DOM snapshot is intentionally simple and bounded.
- Session cleanup is idle-timeout based; there is no Codex `SessionStop` hook used here.
- Browser Use URL policy still applies before navigation reaches this backend.

## Design Rules

- Do not register this as `[mcp_servers.*]`; Browser Use will not discover it.
- Keep the backend socket protocol separate from MCP.
- Keep the repo root as the plugin package; do not introduce nested plugin packages.
- License metadata is Apache-2.0.
