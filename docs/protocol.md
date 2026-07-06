# Protocol Notes

This file records the Browser Use protocol details that were verified while building the backend.

## Transport

Transport is a Unix socket in `/tmp/codex-browser-use`.

Frames:

1. 4-byte unsigned integer payload length.
2. UTF-8 JSON payload.

The Browser plugin client uses host endianness for the length header. `src/framing.mjs` mirrors that behavior.

Payloads are JSON-RPC 2.0 objects:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "getInfo", "params": {} }
```

Responses:

```json
{ "jsonrpc": "2.0", "id": 1, "result": {} }
```

Errors:

```json
{ "jsonrpc": "2.0", "id": 1, "error": { "code": 1, "message": "..." } }
```

## Discovery Methods

### `getInfo`

Returns backend metadata. Browser Use filters IAB candidates by `metadata.codexSessionId`.

### `ping`

Returns `"pong"`.

## Direct Session Methods

These methods are called directly on the socket API:

- `getTabs`
- `getUserTabs`
- `createTab`
- `claimUserTab`
- `getUserHistory`
- `finalizeTabs`
- `markTab`
- `nameSession`
- `attach`
- `detach`
- `attachTarget`
- `detachTarget`
- `executeCdp`
- `allowDownload`
- `moveMouse`
- `executeUnhandledCommand`

`attach`, `detach`, `attachTarget`, and `detachTarget` are currently no-ops because this backend owns its CDP page connections internally.

## Command Types Through `executeUnhandledCommand`

Implemented:

- `runtime_config`
- `name_session`
- `create_tab`
- `close_tab`
- `selected_tab`
- `list_tabs`
- `browser_user_open_tabs`
- `browser_user_history`
- `browser_user_claim_tab`
- `finalize_tabs`
- `mark_tab`
- `tabs_content`
- `navigate_tab_url`
- `navigate_tab_back`
- `navigate_tab_forward`
- `navigate_tab_reload`
- `tab_screenshot`
- `playwright_evaluate`
- `playwright_dom_snapshot`
- `playwright_wait_for_load_state`
- `playwright_wait_for_url`
- `playwright_wait_for_timeout`
- `tab_get_js_dialog`

Unsupported commands return JSON-RPC errors. Add new commands in `src/backend.mjs` and engine support in `src/chrome-engine.mjs`.

## Browser Use URL Policy

Codex Browser Use applies URL policy before calling the backend. For example, `data:` navigation may be rejected before it reaches `navigate_tab_url`. Use local HTTP URLs in smoke tests.
