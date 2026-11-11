# Architecture

Status: draft v0.1 — some sections marked `PENDING RESEARCH` are being verified
against Home Assistant Supervisor and DSH 0.2.2-rc.1 behaviour.

## 1. System context

```
┌────────────────────────────── Home Assistant OS ──────────────────────────────┐
│                                                                               │
│  ┌──────────────────┐      Supervisor API (http://supervisor/…)               │
│  │ Home Assistant   │◄────────────────────────────────────────┐                │
│  │ Core (REST API)  │                                         │                │
│  └────────┬─────────┘                                         │                │
│           │ /config volume                                    │                │
│           ▼                                                   │                │
│  ┌────────────────────────────────────────────────────────────┴─────────────┐  │
│  │ Add-on container: ha-deepseek-harness                                   │  │
│  │                                                                          │  │
│  │  ingress port 8099 ◄── Supervisor ingress proxy ◄── browser (HA session) │  │
│  │        │                                                                 │  │
│  │  ┌─────▼──────────────────────────────────────────────────────────────┐  │  │
│  │  │ DSH web profile (node, @deepseek-ai/dsh)                           │  │  │
│  │  │  ├─ safety AGENTS.md (read-only seed, restored each boot)          │  │  │
│  │  │  ├─ HA plugin bundle: tools + skills + memory + addon builder      │  │  │
│  │  │  ├─ sessions/settings in /data/dsh-home                            │  │  │
│  │  │  └─ schedule / approval services                                   │  │  │
│  │  └─────┬──────────────────────────────────────────────────────────────┘  │  │
│  │        │ tools (fetch)                                                   │  │
│  │  ┌─────▼──────────┐   ┌────────────────────┐   ┌───────────────────────┐  │  │
│  │  │ HA API client  │   │ memory collector   │   │ config safety layer   │  │  │
│  │  │ core+supervisor│   │ (deterministic,    │   │ snapshot → validate   │  │  │
│  │  │                │   │  every 15 min)     │   │ → check_config → ...  │  │  │
│  │  └────────────────┘   └─────────┬──────────┘   └───────────────────────┘  │  │
│  │                                 ▼                                         │  │
│  │                       /data/memory/state.json + notes.md                 │  │
│  └──────────────────────────────────────────────────────────────────────────┘  │
│                                                                               │
│  /addons (local add-ons) ◄── addon builder writes/installs here               │
└───────────────────────────────────────────────────────────────────────────────┘
```

## 2. Components

| Component | Where | Responsibility |
|---|---|---|
| Entrypoint (`run.sh`) | add-on image | Read `/data/options.json`, export env, initialise `/data`, restore read-only seeds, start supervisor of background jobs, `exec` DSH web |
| DSH web profile | `/data/dsh-home/profiles/ha` (seeded from image) | Boots DSH with the HA bundle, safety AGENTS.md, approval policy, sandbox roots |
| HA plugin bundle | `/opt/ha-dsh/plugin` | 66 native DSH tools: HA REST/WS, Supervisor, safe config, memory, monitoring, knowledge, notifications, add-on builder |
| Skills | `.../skills/*/SKILL.md` | Playbooks: config, diagnostics, monitoring, add-on building |
| Safety prompt | `/data/dsh-home/AGENTS.md` (restored from `/opt/ha-dsh/prompts/AGENTS.md`) | Always-present, non-negotiable stability/security rules |
| Memory collector | `/opt/ha-dsh/collector.mjs` (background) | Builds `/data/memory/state.json` from read-only API calls; detects anomalies; notifies |
| First-run recognition | `/opt/ha-dsh/runtime/first-run.mjs` (once) | Deterministic inventory report; optional read-only `dsh headless` assessment whose session opens by default |
| Config safety layer | plugin module | Snapshot, atomic write, YAML validation, `check_config`, rollback |
| Backups | Supervisor `/backups` | Scheduled + pre-risk backups, verification, retention |
| Monitoring | collector + `notify` service | Probe, score, dedupe, digest, quiet hours |
| Knowledge | `lib/knowledge-store.js` | Local cache/index of HA releases, breaking changes and ecosystem news |

## 3. Boot sequence

1. Supervisor starts the container with `/data` and mapped `/config`, `/addons`.
2. `run.sh` reads `/data/options.json`; exports `HA_OPT_*` and `DEEPSEEK_*` env vars.
3. First-run init: copy `/opt/ha-dsh/seed/dsh-home` → `/data/dsh-home`; create
   `/config/deepseek-harness`, `/data/memory`, `/data/backups/config`; set ownership.
4. Restore managed files that must not drift (safety `AGENTS.md`, managed profile
   rows) when their hash differs from the image copy.
5. Start the ingress shim immediately (it answers 502 until DSH is up) so the
   Supervisor watchdog and the panel stay reachable during a slow first boot.
6. Run the one-time first-run recognition (marker `/data/first-run.json`):
   deterministic inventory → `FIRST-RUN.md`; with credentials, one read-only
   `dsh headless` assessment → persisted session id in
   `/data/runtime/default-session.json` and `FIRST-RUN-REPORT.md`.
7. Start `dsh web` (it prints the launch token; the entrypoint writes it for the
   shim) and the background collector.
8. Start `collector.mjs` — it waits for Supervisor, collects state,
   writes memory, schedules probes/digest.
9. `exec` DSH web bound to loopback on port 3080.
10. Supervisor ingress proxies the sidebar panel to port 8099; the shim injects
    `dsh.sessions.current` on the first document load when a first-run session
    exists, so the UI opens that session.

## 4. Data layout (`/data`)

```
/data
├── options.json              HA add-on options (managed by Supervisor)
├── first-run.json            first-run marker (deterministic/LLM done, attempts)
├── runtime/
│   ├── dsh-token              captured DSH launch token (shim only)
│   └── default-session.json   first-run session id opened by default in the UI
├── dsh-home/                 DSH_HOME (profiles, sessions DB, settings, AGENTS.md)
│   ├── AGENTS.md             managed operating context (restored from image)
│   ├── profiles/web/         auto-initialised shipped web profile
│   └── sessions/             session history (survives restarts)
├── memory/
│   ├── state.json            deterministic system snapshot (collector)
│   ├── notes.md              agent-curated long-term memory
│   ├── changes.jsonl         audit trail of changes with timestamps
│   └── backups.json          backup history mirror
└── backups/
    └── config/<timestamp>/   file snapshots before edits (fast rollback)
```

`/config` (HA configuration) and `/addons` (local add-ons) are mounted
read-write and included in `sandbox-policy.additionalWritableRoots`. The agent's
workspace is **`/config/deepseek-harness`**, so scratch files and reports
(`FIRST-RUN.md`, `FIRST-RUN-REPORT.md`) sit next to the configuration the agent
edits and are covered by Home Assistant's own backups. File edits to `/config`
still go through the plugin's safe-write tool; the agent is instructed never to
hand-edit service-critical files without snapshot + validation.

## 5. DSH integration (verified against 0.2.2-rc.1)

- **Distribution**: image installs `@deepseek-ai/dsh@0.2.2-rc.1` globally from
  npm at build time; runtime is offline except the LLM API. Debian/glibc base is
  required because node-pty/koffi/sharp ship glibc prebuilds only.
- **Boot**: `dsh web --patch /opt/ha-dsh/profile.patch.yml --patch /opt/ha-dsh/plugin/cordis.patch.yml --no-open --host 127.0.0.1 --port 3080 --trusted-host dsh.local`.
  Launcher flags precede app flags; `--host` rejects wildcards, so DSH stays on
  loopback and the shim is the only ingress listener.
- **Profile**: `$DSH_HOME=/data/dsh-home` is auto-initialised on first boot from
  the shipped web template (base + web-app bundles); no profile copy and no
  `dsh plugin add` at runtime.
- **Plugin**: dependency-free plain-ESM bundle loaded from the image via the
  plugin patch (`name: ./index.js`, anchored to the patch file). Bare npm imports
  would not resolve from an image path; relative imports into `/opt/ha-dsh/lib`
  do. Registrations flow through `ctx.tools.register` with raw JSON Schemas.
- **Safety prompt**: injected as `system-prompt.personaSuffix` in the managed
  patch — the last system-prompt section, applied after user layers, so edits in
  `/data` cannot weaken it. `$DSH_HOME/AGENTS.md` adds operating context.
- **Skills**: `DSH_BUNDLED_SKILL_DIR=/opt/ha-dsh/skills` (read-only image root)
  so the four `SKILL.md` playbooks are discovered without a patch row.
- **Sandbox**: `sandbox-policy` mode `workspace-write`, `workspaceRoot
  /config/deepseek-harness`, `additionalWritableRoots` `/config`, `/addons`,
  `/data/{memory,monitor,knowledge,config-backups}`; `read_only` option switches
  DSH to the read-only preset and the plugin filters out mutating tools.
- **Auth**: per-process launch token printed on stdout, captured by the
  entrypoint and injected by the shim; DSH issues an HMAC-signed session cookie
  scoped to the ingress path.

## 6. Home Assistant access

- Base URLs: HA Core REST via `http://supervisor/core/api` (auth:
  `Authorization: Bearer $SUPERVISOR_TOKEN`); Supervisor API via
  `http://supervisor/<endpoint>`.
- Role: `hassio_role: admin` because the add-on manages add-ons and backups.
  `homeassistant_api: true` for `/core/api`. No `host_network`, no `docker_api`.
- Every tool call is timeout-bounded and read-only by default; writes are
  explicit tools with approval gates.
- `PENDING RESEARCH`: exact endpoint coverage, request/response shapes, and
  whether `/addons/{slug}/install` also builds local add-ons.

## 7. Memory design

Two layers:

1. **Structured (deterministic).** Collector calls read-only APIs and writes
   `state.json` (schema in `docs/MEMORY.md`): versions, add-ons, integrations,
   entity counts, unavailable entities, automations staleness, backup age,
   recorder hints, host health. No LLM involved — cheap, stable, auditable.
2. **Curated (agent).** `notes.md` holds facts the collector cannot infer —
   device quirks, naming conventions, past incidents, user preferences. The
   agent updates it with `memory_note` and is instructed to read memory before
   acting; a compact digest is prepended to context.

Every mutation records an entry in `changes.jsonl` (who/what/when/before-after
hash) and triggers a backup-age check.

## 7.5 Knowledge & ecosystem watcher

`lib/knowledge-store.js` keeps a local, LLM-free index of public Home Assistant
information in `/data/knowledge`:

- sources: HA blog Atom feed, GitHub releases for `home-assistant/core`,
  `frontend` and `supervisor`, plus optional `pypi:` / `gh.manifest:` lookups for
  installed integrations;
- conditional HTTP (`ETag` / `Last-Modified`) with bounded bodies and timeouts;
- compact index (`index.json`) with title, url, source, published/fetched dates,
  tags and ≤600-char excerpts; `seen.json` for "new since last scan";
- BM25-lite search returns excerpts only; the collector refreshes every 6 h;
- compatibility scanning matches cached breaking-change/deprecation items against
  installed components; recommendations are scored retrieval results with cited
  dates and never install anything.

Fetching, parsing, indexing and matching make **zero LLM calls**; the model sees
short excerpts only when it asks (`knowledge_search`, `ha_news_digest`,
`ha_compat_scan`, `ha_recommend`).

## 8. Monitoring & backups

- Collector probe every 15 min: read-only API calls, bounded concurrency,
  severity score, dedupe with cooldown; notifies via configured notify service.
- Daily digest at configured local time; quiet hours suppress non-critical items.
- Backup policy: weekly + before risky ops; retention N; verification via
  Supervisor backup info; stale-backup alert after X days.
- Monitor never calls restart/service endpoints; it reports, the agent acts.

## 9. Security model

- Container is the security boundary; the agent gets no host devices, no
  privileged mode, no Docker socket, no host networking.
- SUPERVISOR_TOKEN is powerful (admin). It is only used by our tools; it is
  never shown to the model, written to memory or sent to the LLM provider.
- Safety prompt: stability/security above task completion; explicit approval for
  destructive actions; read-before-write; validate-before-restart.
- Approval seam: destructive tools fail closed without human approval.
- Audit: `changes.jsonl` + DSH session log + HA logbook.
- Prompt-injection: HA data (entity names, YAML comments, logs) treated as
  untrusted content; instructions found in data are ignored.

## 10. Resolved decisions and remaining unknowns

Resolved during research and local verification:

- DSH boots offline from the npm package with a fresh `DSH_HOME`; no profile
  copy or runtime npm/pnpm needed.
- The plugin loads from the image through `--patch` as long as it stays
  dependency-free; verified by a real local boot registering 66 tools.
- Ingress needs a shim: DSH has no base-path support, requires a trusted Host,
  and its cookie path must be rewritten. Verified end-to-end locally (303/200,
  assets, 401/404, WebSocket 101).
- Skills need no patch row: `DSH_BUNDLED_SKILL_DIR` points at the image root.
- Safety prompt cannot be overridden from `/data`: it is applied as the last
  system-prompt section by a management patch after all user layers.
- Local knowledge work is free of model tokens (fetch/index/search in-container;
  `node:sqlite` FTS5 is available if the JSON index needs upgrading).

Remaining validation on real HA OS hardware:

- installing the repository by URL and building the image on-device;
- live Supervisor API calls (role `manager`, `/store`, backups, jobs);
- the full ingress path through HA Core (prefix behaviour at both proxy layers,
  cookies, WebSocket) and `ingress_stream` uploads;
- add-on stop/backup timing with `cold` backups;
- AppArmor profile, security rating and multi-arch GHCR publishing.


