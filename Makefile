NODE ?= node
NPM ?= npm

.PHONY: help test integration verify plugin-install plugin-package plugin-validate plugin-smoke cleanup status probe

help:
	@printf '%s\n' \
		'Targets:' \
		'  make test             Run unit tests' \
		'  make integration      Run headless Chrome integration test' \
		'  make verify           Run unit, integration, and plugin validation' \
		'  make plugin-install   Install/reinstall the personal Codex plugin' \
		'  make plugin-package   Build a clean plugin artifact under dist/' \
		'  make plugin-smoke     Start a fresh Codex session and verify hook/backend startup' \
		'  make cleanup          Stop backend processes recorded in /tmp/codex-iab-backend' \
		'  make status           Show installed plugin and backend process state' \
		'  make probe SOCKET=... Probe a backend socket with getInfo'

test:
	$(NPM) test

integration:
	$(NPM) run test:integration

verify:
	$(NPM) run verify

plugin-install:
	$(NPM) run plugin:install

plugin-package:
	$(NPM) run plugin:package

plugin-validate:
	$(NPM) run plugin:validate

plugin-smoke:
	$(NPM) run plugin:smoke

cleanup:
	$(NPM) run cleanup

status:
	@codex plugin list --json --available | $(NODE) -e 'let data=""; process.stdin.on("data", c => data += c); process.stdin.on("end", () => { const j = JSON.parse(data); const p = [...j.installed, ...(j.available ?? [])].filter(x => x.name === "codex-iab-backend"); console.log(JSON.stringify(p, null, 2)); });'
	@pgrep -fl 'codex-iab-backend/src/cli.mjs|src/cli.mjs --session-id' || true
	@find /tmp/codex-browser-use -maxdepth 1 -name 'codex-iab-*.sock' -print 2>/dev/null | sort || true

probe:
	@test -n "$(SOCKET)" || (echo 'Usage: make probe SOCKET=/tmp/codex-browser-use/codex-iab-....sock' >&2; exit 2)
	$(NPM) run probe -- "$(SOCKET)"
