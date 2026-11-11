# Plugin & runtime implementation spec (v0.1)

Authoritative contracts for the code under
`deepseek_harness/rootfs/opt/ha-dsh/`. Derived from
[`docs/research/ha-domain.md`](research/ha-domain.md) (tool surface, safety,
memory, monitoring, knowledge) and [`docs/research/ha-addon.md`](research/ha-addon.md)
(endpoints, ingress, packaging).

Everything is plain ESM JavaScript for Node 24, **no third-party dependencies**
(the DSH plugin is loaded from an image path through `--patch`; bare-package
imports would not resolve). Only `node:` builtins and `fetch` are used.

## 1. Layout

```
deepseek_harness/rootfs/opt/ha-dsh/
├── lib/                    shared modules (single source of truth)
│   ├── result.js           result envelope + tool error helper + redaction
│   ├── safety.js           operation classes, deny-lists, option gates, approval
│   ├── supervisor.js       Supervisor API client (token, timeout, parse)
│   ├── ha-core.js          HA Core REST client over /core/api
│   ├── config-files.js     safe /config read/write (snapshot, sha256, YAML check)
│   ├── memory-store.js     /data/memory system.json/system.md/changelog
│   ├── monitor-store.js    monitor config/state/findings + probe logic
│   ├── knowledge-store.js  /data/knowledge cache + news fetch/parse + index
│   ├── addon-builder.js    addon scaffold/validate/build helpers
│   ├── notify.js           persistent_notification + notify service, quiet hours
│   └── paths.js            resolved env paths and options
├── plugin/                 DSH bundle (loaded via --patch)
│   ├── package.json        dsh.bundle manifest (documentation + npm metadata)
│   ├── cordis.patch.yml    insert row -> ./index.js
│   └── index.js            registers every tool; imports ../lib/*
├── runtime/
│   ├── collector.mjs       deterministic background loop (state, monitor, news, backups)
│   └── ingress-shim.mjs    HTTP/WS reverse proxy 0.0.0.0:8099 -> 127.0.0.1:3080
├── prompts/AGENTS.md       safety-first managed system prompt (copied to DSH_HOME)
└── skills/<name>/SKILL.md  playbooks copied into DSH_HOME/skills
```

`lib/` is imported by both the plugin and runtime with relative paths
(`import { ... } from '../lib/supervisor.js'`); the plugin directory itself is
the bundle root referenced from `cordis.patch.yml` by `./index.js`.

## 2. Environment and paths (`lib/paths.js`)

| Env var | Default | Meaning |
|---|---|---|
| `SUPERVISOR_TOKEN` | — | add-on token injected by Supervisor; never log it |
| `DSH_SUPERVISOR_URL` | `http://supervisor` | Supervisor base URL |
| `DSH_HA_CONFIG_DIR` | `/config` | HA configuration dir (rw) |
| `DSH_HA_ADDONS_DIR` | `/addons` | local add-ons dir (rw) |
| `DSH_DATA_DIR` | `/data` | persistent data |
| `DSH_OPT_READ_ONLY` | `false` | if true only R/SW-read tools are registered |
| `DSH_OPT_ALLOW_RESTARTS` | `false` | gate `ha_restart` |
| `DSH_OPT_ALLOW_ADDON_MANAGEMENT` | `false` | gate install/update/remove/rebuild |
| `DSH_OPT_MONITOR_ENABLED` | `true` | collector probe + digest |
| `DSH_OPT_NOTIFY_SERVICE` | `` | e.g. `notify.mobile_app_pixel`; empty = persistent only |
| `DSH_OPT_QUIET_HOURS` | `` | `HH:MM-HH:MM` |
| `DSH_OPT_BACKUP_RETENTION` | `7` | backups kept locally/ledger |
| `DSH_OPT_PUBLIC_URL` | `` | advertised UI root for DSH runtime context |

Paths: `DATA = /data`, `MEMORY = /data/memory`, `MONITOR = /data/monitor`,
`KNOWLEDGE = /data/knowledge`, `CONFIG_BACKUPS = /data/config-backups`.

Options are booleans parsed case-insensitively from env; an absent value means
the default. `paths.js` exports a frozen `paths` object and `options()`.

## 3. Result envelope (`lib/result.js`)

Every tool returns a canonical object (schema
`{ type: 'object', additionalProperties: true }`):

```json
{ "ok": true, "summary": "…", "data": {}, "warnings": [], "meta": { "source": ["GET /api/states"], "fetched_at": "…", "redacted": false, "truncated": false } }
```

On failure: `{ "ok": false, "error": { "code": "NOT_FOUND|FORBIDDEN|UNSUPPORTED|UPSTREAM_ERROR|NEEDS_APPROVAL|CONFLICT|INVALID_ARGUMENT|INTERNAL", "message": "…", "hint": "next safe action", "retryable": false } }`.
Never throw raw errors out of a tool: wrap in `fail()`; render with
`renderJson` → `[{ type: 'text', text: JSON.stringify(value) }]`.

Helpers: `ok(summary, data, meta?, warnings?)`, `fail(code, message, hint?)`,
`redact(value)` (mask keys matching `/token|password|secret|key|authorization/i`,
except allow-listed info keys such as `api_key` never present), `truncate(text, n)`,
`sha256(text)`, `nowIso()`. `meta.source` lists endpoints touched.

## 4. Safety (`lib/safety.js`)

Operation classes: `R` read, `SW` scoped write, `ACT` act, `DIS` disruptive,
`DES` destructive, `X` forbidden. Export:

- `CLASS` constants and `classify(toolName)`.
- `denyService(domain, service)` → reason string or `null`. Deny domains:
  `shell_command`, `python_script`, `pyscript`, `hassio` (except via sup_*),
  `homeassistant.restart|stop` (dedicated tool only). Return reason to the model.
- `DENY_CONFIG_PATHS = ['.storage', 'deps', 'tts', '.cloud', '*.db', '*.db-*']`
  and `CORE_CONFIG_FILES = ['configuration.yaml', 'secrets.yaml', 'automations.yaml', 'scripts.yaml', 'scenes.yaml', 'groups.yaml', 'customize.yaml']`.
- **Approval protocol (dry-run + single-use token)** — no dependency on DSH's
  internal approval service, works in chat:
  1. A DIS/DES tool called **without** `confirmation_token` performs all
     read-only preflight work it can, then returns
     `ok:false`, `error.code: "NEEDS_APPROVAL"`, and a `data` payload
     `{action, target, impact, rollback, backup_suggestion, token, expires_at}`.
     `token` is a random id bound to `sha256(toolName + stable-stringify(args))`
     and the current process, TTL 5 min, single use, held in memory.
  2. The model explains the impact to the user and waits for an explicit yes.
  3. The same call with `confirmation_token` set and otherwise identical args
     executes once, then the token is consumed. Mismatched args/expired token →
     `CONFLICT` with a fresh token.
- `issueConfirmation(toolName, args, plan)` / `consumeConfirmation(toolName, args, token)`
  implement the above. Plans include the resolved HA version, backup age, and
  target slugs so the user sees real facts.
- Option gates: `canRestart()`, `canManageAddons()`, `readOnly()`.
- `filterTools(tools, { readOnly })` used by `plugin/index.js`.

Approval reasons must be short, human, and explain the effect + rollback
("Restart HA Core; ~30 s downtime; recent backup: 2026-11-10, 3 h old").

## 5. Clients

`lib/supervisor.js`: `sup(path, method='GET', body, { timeoutMs=20000 })` →
`{ ok, status, data }`; throws `ToolError` with `code` on network failure/timeout;
auth `Bearer ${SUPERVISOR_TOKEN}`; JSON parse with text fallback; never log token.
Also `job(slug)` helpers.

`lib/ha-core.js`: `ha(path, method, body)` → same, base `${supervisor}/core/api`;
convenience `states(filters)`, `state(id)`, `service(domain, service, data)`,
`config()`, `checkConfig()`, `renderTemplate()`, `errorLog()`.

Both accept an `AbortSignal` and set `AbortSignal.timeout`.

## 6. Tool catalog (names are the contract from ha-domain.md Appendix A)

Read-only (`R`) — always registered unless noted:
`ha_get_config`, `ha_get_states`, `ha_get_state`, `ha_get_services`,
`ha_get_history`, `ha_get_logbook`, `ha_get_error_log`, `ha_get_config_check`,
`ha_render_template`, `ha_list_automations`, `sup_get_info`, `sup_get_resolution`,
`sup_get_updates`, `sup_list_addons`, `sup_get_addon`, `sup_addon_logs`,
`sup_get_store`, `sup_backup_list`, `sup_backup_info`, `sup_job_status`,
`sup_get_logs`, `config_list`, `config_read`, `config_search`, `memory_get`,
`memory_refresh`, `monitor_probe` (notify=false default), `monitor_history`,
`monitor_configure` (get branch), `ha_news_scan`, `ha_news_digest`,
`knowledge_search`, `addon_validate`.

WebSocket-backed diagnostics (`R`; Node 24 global WebSocket,
`ws://supervisor/core/websocket`, auth via `auth_required`/`auth` then one
command; timeouts + `UNSUPPORTED` fallback): `ha_list_registry`,
`ha_get_repairs`, `ha_get_system_log`, `ha_get_automation_trace`. Keep one
short-lived connection per call in v1 (simple, robust).

Writes/actions (dry-run + token protocol from §4):
- `config_write`, `config_edit`, `config_snapshot` (SW; allowed, snapshot+validate default true).
- `config_delete` (DES; token; core files need `allow_core_files=true`).
- `config_restore` (SW; token when restoring core files).
- `memory_update` (SW).
- `ha_call_service` (ACT; denied domains refused; safety domains need token).
- `ha_reload` (ACT; allowed).
- `ha_restart` (DIS; requires `allow_restarts` + token; `reason` required).
- `sup_addon_start` (ACT; allowed), `sup_addon_stop`/`sup_addon_restart` (ACT; token).
- `sup_set_addon_options` (SW; token when options redacted/non-self).
- `sup_addon_install`, `sup_addon_update`, `sup_addon_uninstall`,
  `sup_addon_rebuild` (DIS/DES; require `allow_addon_management` + token;
  install/update/uninstall require `backup=true` or a fresh backup — otherwise
  NEEDS_APPROVAL with hint).
- `sup_store_reload` (SW).
- `sup_backup_create` (SW; allowed, background job), `sup_backup_restore`
  (DES; token + `confirm_slug`).
- `sup_core_update` (DIS; token; `backup=true` default).
- `monitor_probe` with `notify=true` (ACT; notification), `monitor_digest`,
  `monitor_configure` (ACT/SW).
- `notify_user` (ACT; quiet hours unless critical).
- `addon_scaffold` (SW; refuses overwrite without `overwrite=true`).
- `addon_build` (DIS; `allow_addon_management` + token).

Excluded entirely (never register): raw state writes, events, `/api/stream`,
OS datadisk/wipe, auth, protection-mode toggles, `.storage`, secrets values.
`read_only` option registers only `R` tools + `config_snapshot`/`memory_update`
(no HA mutations).

Each tool: JSON-Schema `parameters` (`additionalProperties:false` where fixed),
canonical `output.schema = {type:'object', additionalProperties:true}`, `execute`
returns the envelope; optional `presentCall`/`presentResult` omitted in v1.

## 7. Memory (`lib/memory-store.js`)

Files under `/data/memory`: `system.json`, `system.md`, `changelog.jsonl`,
`backups.json`, `baselines.json`. Schema and rules: `ha-domain.md` §6.
API:

- `readMemory({sections, fresh, collected})` → `{schema_version, revision, updated_at, collected, curated, changelog_tail, backups, stale}`.
- `updateMemory({ops, reason, base_revision, collected})` → new revision;
  ops: `set`, `append`, `add_quirk`, `resolve_quirk`, `record_change`,
  `record_backup`; refuses `collected` edits (`FORBIDDEN`), enforces bounds
  (curated ≤32 KB / 200 entries) and revision CAS.
- `refreshCollected(collector)` → runs collection, writes `system.json` +
  atomic `system.md`, returns diff summary; used by `memory_refresh` and the
  background collector.
- `recordChange(entry)` appends to `changelog.jsonl` (rotate at 2 MB).

`system.md` is user-readable, contains curated notes + a compact inventory
summary, never secrets. Atomic writes (temp + rename), file mode 0600.

## 8. Monitor (`lib/monitor-store.js`)

`probe({deep, notify})` evaluates `ha-domain.md` §5.1 signals using read-only
clients, updates `/data/monitor/state.json` (baselines, cooldowns, last run),
appends findings to `/data/monitor/findings.jsonl`, and optionally sends
`notify_user` for severity ≥ 2 outside quiet hours. Findings have
`{id, severity (0-3), code, title, detail, evidence[], first_seen, last_seen, count}`.
`digest({send, window_h})` renders ≤20 lines Markdown and sends it; 0 LLM calls.
`history({since, severity_min, limit})`. The background collector calls
`probe` every `DSH_MONITOR_INTERVAL_MIN` (default 15) and `digest` daily at
`DSH_DIGEST_TIME` (default 08:00 local), both persisted in `state.json`.

## 9. Knowledge / news (`lib/knowledge-store.js`)

Local-first, zero LLM: conditional HTTP (ETag/Last-Modified) fetch of
`ha-domain.md` §7.2 sources into `/data/knowledge/cache/<source>/…json`,
a compact index `/data/knowledge/index.json` (title, url, published_at,
fetched_at, source, tags, ≤600-char excerpt), `seen.json` for "new since last
scan". `scan({sources, force})` returns new items; `digest({window_days})`
renders deterministic Markdown; `search({query,k,sources,since,max_excerpt})`
scores index entries (token overlap/BM25-lite, no embeddings) and returns
excerpts only. Network failures degrade to cache (`stale[]`). Never send HA
internals: only public source URLs are fetched.

## 10. Addon builder (`lib/addon-builder.js`)

`scaffold(spec)` writes `/addons/<slug>/` with `config.yaml`, `Dockerfile`,
`run.sh` (LF, executable), `README.md`, `CHANGELOG.md`, `translations/en.yaml`,
optional `rootfs/`; `validate(slug)` returns `{errors[], warnings[], available}`
per `ha-domain.md` §8.3; `build({slug, mode, force, wait})` = `POST /store/reload`
→ install/rebuild job → poll `/jobs/<id>` → collect `sup_addon_logs` +
`sup_get_logs` on failure. Slug rules: `[a-z0-9_-]{1,64}`, no reserved names.

## 11. Runtime

`runtime/collector.mjs`: process started by the add-on run script; waits for
Supervisor, runs `refreshCollected`, `probe`, news scan (default every 6 h),
backup-age check, daily digest; respects `DSH_OPT_MONITOR_ENABLED`; exits on
SIGTERM; structured logs to stdout. 0 LLM calls.

`runtime/ingress-shim.mjs`: listens on `0.0.0.0:${DSH_INGRESS_PORT:-8099}`,
rejects peers outside `172.30.32.0/23` + loopback, proxies to
`127.0.0.1:${DSH_WEB_PORT:-3080}` with `Host`/`Origin` normalized to
`127.0.0.1:3080`, forwards `Upgrade` for WebSockets, rewrites `Set-Cookie`
`Path=/` to `Path=<X-Ingress-Path>/` (plus `Secure` when `X-Forwarded-Proto`
is https), and never caches. See `docs/research/dsh-container.md` for the
verified DSH web behaviour before finalising.

## 12. Testing

`tests/plugin/run.mjs` uses `node:test` + `assert`, stubs `globalThis.fetch`
with a router returning canned Supervisor/HA payloads, builds a fake Cordis
context (`{ tools: { register(t) { tools.push(t) } }, get(name) {...} }`),
imports `plugin/index.js`, and asserts:
- exact tool names registered, read_only filtering;
- envelope shape for a read tool;
- `ha_call_service` refuses `shell_command` and asks approval for `lock`;
- `config_write` snapshots + validates + rolls back on invalid YAML;
- `memory_update` revision CAS and curated bounds;
- `addon_scaffold` + `addon_validate` on a temp dir;
- ingress shim rewrites cookie Path and rejects a foreign peer (unit-level).

`node tests/plugin/run.mjs` must pass on Windows/Node 24 without network.
