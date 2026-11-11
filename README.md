# DeepSeek Harness for Home Assistant

A Home Assistant **add-on** that runs the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(`dsh`) agent inside your smart home — with access to the Home Assistant API, the
`/config` directory, the Supervisor and your local apps — so it can help you
configure, monitor, maintain and extend your installation.

> **Developer preview (v0.1).** The add-on can change your Home Assistant
> configuration and manage apps; a safety layer (managed system prompt,
> confirmation tokens, snapshots, validation, capability options) is designed for
> that power. Review [docs/SECURITY.md](docs/SECURITY.md) and start with
> `read_only` if you want to evaluate it first.

## What it does

- **Chat UI in your sidebar.** The full DSH Web UI is served through Home
  Assistant ingress; no extra port, no second login.
- **Knows your home.** A deterministic collector keeps a structured snapshot
  (versions, integrations, entities, automations, apps, backups) and the agent
  curates durable notes about quirks, preferences and past changes — its own
  persistent memory in `/data/memory`.
- **Configures safely.** Snapshots → atomic write → server-side config check →
  automatic rollback; reload preferred over restart; SHA-256 read-before-write.
- **Monitors and maintains.** 15-minute health probe, error-log signatures,
  stale-backup and update awareness, deduplicated findings, daily digest,
  notifications.
- **Takes care of backups.** Supervisor backups before risky operations and on
  request, verification, retention and a backup ledger.
- **Builds apps (add-ons).** Scaffolds, validates, builds and debugs local apps
  in `/addons` with you.
- **Keeps up with Home Assistant.** Release notes, breaking changes and
  ecosystem news are fetched, cached and indexed **locally** — zero model tokens
  for fetching/searching — so it can warn before an update and recommend fitting
  integrations with cited dates.
- **Safety first.** A managed system prompt ranks Home Assistant stability,
  security and privacy above task completion; disruptive actions require an
  explicit, per-action confirmation.

## Installation

1. **Settings → Add-ons → Add-on Store → ⋮ → Repositories**
2. Add `https://github.com/ussdeveloper/ha-deepseek-harness`
3. Install **DeepSeek Harness**, set your DeepSeek API key (or enter it in the app
   on first run) and start it.
4. Open it from the sidebar.

Options, first-run steps, data layout, troubleshooting and limitations:
[docs/INSTALL.md](docs/INSTALL.md). Add-on tab documentation:
[deepseek_harness/DOCS.md](deepseek_harness/DOCS.md).

## Repository layout

```
repository.yaml                 HA add-on repository manifest
deepseek_harness/               the add-on
  config.yaml                   HA manifest: ingress, API access, maps, options
  Dockerfile                    node:24-bookworm-slim + npm-installed DSH
  icon.png / logo.png           store assets
  translations/en.yaml          option labels
  rootfs/opt/ha-dsh/
    lib/                        shared plain-ESM modules (no dependencies)
    plugin/                     DSH bundle: 66 native tools
    runtime/                    entrypoint, ingress shim, deterministic collector
    profile.patch.yml           managed DSH overlay (safety prompt, sandbox, approval)
    prompts/AGENTS.md           managed operating context
    skills/                     4 SKILL.md playbooks
scripts/check-addon.mjs         repository/plugin/skills validator
tests/plugin/                   offline tool tests (mocked fetch/WebSocket)
tests/runtime/                  ingress shim unit tests
docs/                           requirements, architecture, security, memory, research
```

## How it works

```
browser ──HA ingress──► add-on:8099 (shim) ──► DSH web:3080
                              │                    │
                              │              HA plugin (66 tools)
                              │                    │
                     /config ◄─┴── /addons    Supervisor API, HA REST/WS
                              │
                    collector.mjs ──► /data/memory, /data/monitor, /data/knowledge
```

- DSH is installed from npm at image build; runtime is offline except the LLM API.
- The plugin is dependency-free plain ESM loaded from the image via a `--patch`
  overlay, so `/data` edits cannot shadow it.
- The shim strips the ingress prefix, normalises the browser-trust host, scopes
  DSH cookies to the ingress path and forwards WebSockets.
- The collector runs with **no LLM calls**; the model only reasons when you ask.

Architecture details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and the
verified research notes in [docs/research/](docs/research/).

## Safety model

- Managed safety-first system prompt (`profile.patch.yml` → `personaSuffix`), last
  prompt section, applied after user layers; not editable from chat.
- Destructive/disruptive tools use a dry-run → confirmation-token protocol bound
  to exact arguments (single use, 5 min TTL).
- Capability options: `read_only`, `allow_restarts`, `allow_addon_management`.
- Deny-lists: `shell_command`/`python_script`/`hassio` services, `.storage`,
  databases, `secrets.yaml` values, OS/datadisk endpoints.
- Least privilege manifest: no `host_network`, no `docker_api`, no `privileged`;
  ingress-only (port 8099 not published).

More: [docs/SECURITY.md](docs/SECURITY.md).

## Development

Requirements: Node.js 24. Docker is optional (image builds only).

```sh
node scripts/check-addon.mjs        # manifest, plugin bundle, skills, icons
node tests/plugin/core.test.mjs     # HA/Supervisor/config tools (18 tests)
node tests/plugin/state.test.mjs    # memory/monitor/knowledge/builder (21 tests)
node tests/runtime/shim.test.mjs    # ingress shim helpers (12 tests)
```

All tests are offline: Supervisor and HA are stubbed, no Docker or HA required.
See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for a local DSH boot, the image
build, and how to update the pinned DSH version.

## Status

Implemented and unit-verified in this scaffold:

- add-on manifest, Dockerfile, repo manifest, icons, translations, docs;
- DSH 0.2.2-rc.1 boot from npm with the managed profile patch and the plugin
  bundle registering **66 tools** (39 read-only) — verified with a real local
  DSH boot;
- ingress shim verified end-to-end against a local DSH: bare-prefix 308,
  document 303 + path-scoped cookie, 200 HTML, assets 200, `/api` 401/404,
  WebSocket `101`;
- 51 offline tests across plugin, memory/monitor/knowledge/builder and the shim.

Still to validate on real hardware: HA OS install/build, Supervisor API calls
against a live instance, full ingress path through HA Core, AppArmor profile,
multi-arch image publishing (GHCR) and long-running collector behaviour.

## License

MIT — see [LICENSE](LICENSE). DeepSeek Harness itself is MIT-licensed.

