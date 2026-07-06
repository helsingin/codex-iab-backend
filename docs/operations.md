# Operations

## Install Or Reinstall The Plugin

From the repo root:

```sh
make plugin-install
```

This does all local setup:

1. Updates the root plugin manifest version with a Codex cache-buster suffix.
2. Creates `~/plugins/codex-iab-backend` as a symlink to this repo root.
3. Creates or updates `~/.agents/plugins/marketplace.json`.
4. Installs the plugin with `codex plugin add codex-iab-backend@personal`.

The installed package is a standard Codex plugin package. The root manifest is `.codex-plugin/plugin.json`; hook registration is in `hooks/hooks.json`.
The installer does not rewrite hook commands to machine-local absolute paths.
The hook command uses Codex's `PLUGIN_ROOT` hook environment to locate packaged scripts.

## Trust The Hook Once

Codex skips non-managed hooks until they are trusted. After install:

1. Start a new interactive Codex session.
2. Run `/hooks`.
3. Trust the `codex-iab-backend` `SessionStart` hook.

Noninteractive tests can use `--dangerously-bypass-hook-trust`, but normal sessions should use persisted hook trust.

## Smoke Test

```sh
make plugin-smoke
```

The smoke test:

1. Starts `codex exec --dangerously-bypass-hook-trust`.
2. Lets the installed plugin `SessionStart` hook run.
3. Reads the hook dump.
4. Probes the created backend socket with `getInfo`.
5. Stops the spawned backend unless `--keep` is passed.

Run the underlying script directly for options:

```sh
node scripts/smoke-session-hook.mjs --keep
```

## Build A Clean Plugin Artifact

```sh
make plugin-package
```

This validates the root plugin package, copies the publishable project contents
to `dist/codex-iab-backend/`, and creates `dist/codex-iab-backend.tar.gz`.
The package output excludes `.git`, `node_modules`, `dist`, coverage, logs, and
socket files.

## Manual Backend Run

```sh
CODEX_SESSION_ID=<session-id> npm start
```

Manual runs use `/tmp/codex-browser-use/codex-iab-<session-id>.sock` by
default. A second backend will refuse to start if that socket is already active;
stop the existing process first instead of starting duplicate session backends.

Useful flags:

```sh
node src/cli.mjs --session-id <id> --headless false
node src/cli.mjs --session-id <id> --chrome-path "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
node src/cli.mjs --session-id <id> --idle-timeout-ms 300000
```

## Probe A Socket

```sh
node scripts/probe-socket.mjs /tmp/codex-browser-use/codex-iab-<session-id>.sock
```

or:

```sh
node scripts/probe-socket.mjs --session-id <session-id>
```

## Cleanup

```sh
make cleanup
```

This reads state files under `/tmp/codex-iab-backend`, kills recorded backend PIDs when they still exist, and removes stale `codex-iab-*.sock` sockets.

## Logs And State

- Backend logs: `~/.codex/codex-iab-backend/logs/<session-id>.log`
- Runtime state: `/tmp/codex-iab-backend/codex-iab-<session-id>.sock.json`
- Backend sockets: `/tmp/codex-browser-use/codex-iab-<session-id>.sock`

## Environment Variables

- `CODEX_SESSION_ID`: session id for manual backend runs.
- `BROWSER_USE_CODEX_APP_BUILD_FLAVOR`: defaults to `prod`.
- `CODEX_IAB_PIPE_DIR`: socket directory, defaults to `/tmp/codex-browser-use`.
- `CODEX_IAB_SOCKET_NAME`: explicit socket name.
- `CODEX_IAB_CHROME_PATH`: explicit Chrome binary path.
- `CODEX_IAB_HEADLESS`: defaults to `true`.
- `CODEX_IAB_IDLE_TIMEOUT_MS`: idle shutdown timer for session backends.
- `CODEX_IAB_DEBUG_CDP`: set to `1` to log CDP method, target, elapsed time,
  and errors for Browser Use compatibility debugging.
- `CODEX_IAB_BACKEND_HOOK_DUMP`: write hook payload/result JSON for tests.
- `PLUGIN_ROOT`: provided by Codex to plugin hook commands; used to locate packaged scripts.
- `PLUGIN_DATA`: provided by Codex to plugin hook commands; reserved for future plugin-owned state.

## Troubleshooting

### Plugin appears installed but hook does not run

Run `/hooks` in an interactive Codex session and trust the hook. If you changed the plugin package, reinstall:

```sh
make plugin-install
```

### Browser Use says no IAB backend is available

Check:

```sh
make status
find /tmp/codex-browser-use -maxdepth 1 -name 'codex-iab-*.sock' -print
```

Then probe the socket:

```sh
node scripts/probe-socket.mjs --session-id <session-id>
```

The `metadata.codexSessionId` must exactly match the current Codex session id.

### Chrome does not start

Set `CODEX_IAB_CHROME_PATH`:

```sh
CODEX_IAB_CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm run test:integration
```

Check the backend log for Chrome startup errors.

### Hook starts backend for the wrong session

This was fixed by preferring hook payload `session_id` over inherited environment variables. Re-run:

```sh
make verify
make plugin-install
make plugin-smoke
```

### A backend process is left running

```sh
make cleanup
```

If a manually-started backend was not recorded in state, find the socket owner:

```sh
lsof -U | grep codex-iab-<session-id>.sock
```
