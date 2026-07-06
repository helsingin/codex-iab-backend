# codex-iab-backend

Local IAB backend for Codex Browser Use.

## Why

Codex Browser Use discovers in-app-browser backends over local IAB sockets. If
no backend is registered, Browser Use cannot open or verify local pages.

This plugin starts a per-session headless Chrome backend and advertises it on
`/tmp/codex-browser-use` with the current Codex session id.

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

## Notes

- Not an MCP server.
- No npm dependencies.
- Uses local Chrome through Chrome DevTools Protocol.
- Apache-2.0 licensed.
