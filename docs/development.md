# Development

## Requirements

- macOS with Google Chrome installed at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, or set `CODEX_IAB_CHROME_PATH`.
- Node 24 or newer.
- Codex CLI for plugin smoke tests.

No npm dependencies are required.

## Common Commands

```sh
make help
make test
make integration
make verify
make plugin-install
make plugin-package
make plugin-smoke
make cleanup
```

Equivalent npm commands:

```sh
npm test
npm run test:integration
npm run verify
npm run plugin:install
npm run plugin:package
npm run plugin:smoke
npm run cleanup
```

## Repo Layout

```text
src/
  backend.mjs          Browser Use method router
  cdp-connection.mjs   minimal CDP WebSocket client
  chrome-engine.mjs    headless Chrome backend
  cli.mjs              long-running backend process
  framing.mjs          length-prefixed JSON frames
  server.mjs           Unix socket JSON-RPC server
  session-hook.mjs     SessionStart hook launcher logic
scripts/
  cleanup-backends.mjs
  install-plugin.mjs
  package-plugin.mjs
  probe-socket.mjs
  smoke-session-hook.mjs
  start-session-backend.mjs
  validate-plugin.mjs
.codex-plugin/
  plugin.json
hooks/
  hooks.json
test/
  *.test.mjs
  integration/chrome-engine.mjs
docs/
```

## Adding Browser Use Methods

1. Find the command type in the Browser plugin client or docs.
2. Add direct method handling in `src/backend.mjs` if it is a JSON-RPC method.
3. Add command handling in `handleCommand` if it arrives through `executeUnhandledCommand`.
4. Add engine implementation in `src/chrome-engine.mjs`.
5. Add focused unit tests in `test/backend.test.mjs`.
6. Add an integration assertion if it requires Chrome.

Use `docs/protocol.md` to record observed method shapes so the next pass does not need to reverse-engineer the Browser plugin again.

## Test Strategy

- Unit tests cover frame parsing, method routing, hook session extraction, and socket RPC behavior.
- Integration test launches headless Chrome, creates a tab, navigates, reads DOM, and captures a screenshot.
- Plugin smoke test starts a real `codex exec` session from a temporary working directory with hook-trust bypass, verifies the hook dump, probes the socket, and stops the spawned backend.

## Release Checklist

Before considering a change stable:

```sh
make verify
make plugin-install
make plugin-package
make plugin-smoke
make cleanup
git status --short
```

If `.codex-plugin/`, `hooks/`, or hook scripts changed, reinstall the plugin. Codex caches plugin contents by version, so `scripts/install-plugin.mjs` is the supported local install path for this project.
