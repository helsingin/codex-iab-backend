# codex-iab-backend

Standalone IAB backend for Codex Browser Use.

## Why

Codex Browser Use depends on discovering and attaching to a session-scoped
IAB-compatible browser backend. When that backend is missing, unavailable, or
the native pipe/handshake fails, Browser Use cannot inspect or control a browser
surface.

This is a known failure class, not a one-off local configuration issue:

- [Browser Use IAB backend cannot attach](https://github.com/openai/codex/issues/20248)
- [Browser Use IAB backend fails to connect on Windows](https://github.com/openai/codex/issues/20846)
- [Windows: Chrome browser backend missing](https://github.com/openai/codex/issues/30688)

`codex-iab-backend` makes the backend explicit. It starts a per-session
headless Chrome backend, publishes it on `/tmp/codex-browser-use`, and
advertises the active Codex session id so Browser Use can discover it.

## Install

```sh
make plugin-install
```

Then start a new Codex session and trust the `codex-iab-backend` hook with
`/hooks`.

## Use

Use Codex Browser Use normally. The plugin's `SessionStart` hook starts the
backend for the current session.

Useful checks:

```sh
make verify
make plugin-smoke
make cleanup
```

## Status

- Tested on macOS only so far.
- Not an MCP server.
- No npm dependencies.
- Uses local Chrome through Chrome DevTools Protocol.
- Apache-2.0 licensed.
