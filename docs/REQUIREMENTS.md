# Requirements — DeepSeek Harness for Home Assistant

Status: v0.1 (derived from the owner's brief, 2026-11-11).
Repo: <https://github.com/ussdeveloper/ha-deepseek-harness> · Owner: `ussdeveloper`.

## 1. Vision

A Home Assistant **add-on** that runs the DeepSeek Harness (`dsh`) agent inside a
container with first-class access to Home Assistant, so the agent can configure,
monitor, maintain and extend a smart home — while treating the stability and
security of the Home Assistant system as its highest priority.

The add-on is the user's resident operator: it knows the installation (its own
persistent memory), it can read and safely edit `/config`, it can use the
Supervisor API, and it can scaffold, build and install new local add-ons.

## 2. Decisions already made

| Decision | Value |
|---|---|
| Packaging | Separate HA add-on repository at `ussdeveloper/ha-deepseek-harness` |
| DSH distribution | npm package `@deepseek-ai/dsh` (not a source fork) |
| Target platform | Home Assistant OS (Supervisor present), amd64 + aarch64 |
| UI | DSH Web UI served through HA ingress (sidebar panel) |
| Language | User-facing UI in English; docs English (owner speaks Polish) |
| Version | v0.1.0 developer preview |

## 3. Functional requirements

### FR-1 Installation & launch
- FR-1.1 Installable by adding the GitHub repository URL in HA → Add-on Store.
- FR-1.2 Appears in the sidebar via ingress; no extra port required for basic use.
- FR-1.3 Configured from HA add-on options: DeepSeek API key, model, base URL,
  safety/monitoring/backup toggles, notification target.
- FR-1.4 Starts within ~60 s on HAOS hardware; restarts cleanly; app options
  changes apply without losing sessions or memory.

### FR-2 Agent access to Home Assistant
- FR-2.1 Home Assistant REST API through Supervisor (`/core/api/...`) for states,
  services, templates, config check, error log, logs.
- FR-2.2 Supervisor API for add-ons, store, backups, host/supervisor info,
  ingress, self info (role must be sufficient for add-on management).
- FR-2.3 `/config` read/write access, `/addons` read/write access.
- FR-2.4 File changes to YAML go through a safe path: snapshot before write,
  atomic write, YAML parse validation, `check_config` before restart, rollback
  on failure.

### FR-3 Persistent system memory (hard requirement)
- FR-3.1 A deterministic collector maintains structured state about the HA
  installation: core/supervisor/OS versions, add-ons and their state/updates,
  integrations, entity/automation counts and unavailable entities, areas,
  backup history, recorder/DB hints, host health.
- FR-3.2 A human-readable, agent-curated memory file records known facts,
  quirks, past changes and decisions; it is updated by the agent and survives
  restarts, updates and backups.
- FR-3.3 On every new session the agent has its memory available (tool or
  injected digest) and is instructed to read it before acting.
- FR-3.4 Memory files live under `/data` and are included in HA backups.

### FR-4 Monitoring & health
- FR-4.1 Periodic cheap health probe (default every 15 min) with severity
  scoring and deduplication.
- FR-4.2 Notifications for material problems (entity unavailable storms,
  integration setup failures, error-log patterns, add-on crash loops, disk/DB
  pressure, stale backups, updates available) via HA notify service and/or
  persistent notification.
- FR-4.3 Daily digest (default 08:00 local) summarising the system; quiet hours
  and mute option.
- FR-4.4 Optional deep analysis using the LLM only when anomalies are detected
  (token-aware; off by default or capped).
- FR-4.5 Monitoring must never itself destabilise HA: read-only API calls,
  bounded concurrency, timeouts, no restarts.

### FR-5 Backups (hard requirement)
- FR-5.1 Check backup age/state; alert when no recent backup exists.
- FR-5.2 Create a Supervisor backup before risky operations (add-on
  install/update/remove, core restart after config changes) and on a schedule
  (e.g. weekly), with retention policy.
- FR-5.3 Verify a backup was created successfully; record it in memory.
- FR-5.4 Config-file snapshots (before edits) are kept separately for fast
  rollback, in addition to full backups.

### FR-6 Add-on builder
- FR-6.1 Scaffold a valid local add-on in `/addons/<slug>` (config.yaml,
  Dockerfile, run.sh, README, icon/logo placeholders, optional ingress).
- FR-6.2 Validate add-on manifests and Dockerfile against HA conventions before
  building.
- FR-6.3 Install/build/start/stop/restart/uninstall through Supervisor; read
  build and runtime logs; iterate on errors with the user.
- FR-6.4 Never build/install without an explicit user confirmation and a
  recent backup.

### FR-7 Safety, security & stability (highest priority)
- FR-7.1 A safety-first instruction layer is always part of the model context
  (not user-editable at runtime without a deliberate action); it ranks HA
  security and stability above completing the task.
- FR-7.2 Destructive actions require explicit human approval in the DSH UI:
  restarts, service calls to dangerous domains, add-on install/update/remove,
  file deletion, backup restore, shell commands with system impact.
- FR-7.3 Read before write; validate before reload/restart; prefer reload over
  restart; snapshot/backup before risky change; explain the plan and risk to
  the user in plain language.
- FR-7.4 Secrets (API keys, tokens, passwords in `secrets.yaml`) are never
  printed, logged, sent to the LLM provider or written outside allowed files.
- FR-7.5 Least privilege manifest: no `host_network`, no `docker_api`, no
  `privileged`, no unnecessary devices; AppArmor enabled.
- FR-7.6 All agent tool actions are logged for audit (tool calls, changes,
  approvals).
- FR-7.7 If the agent cannot verify a safe path, it stops and asks instead of
  guessing.

### FR-8 Updates & lifecycle
- FR-8.1 Show/add-on update checks for HA Core, add-ons and DSH itself.
- FR-8.2 DSH version is pinned in the image; upgrading is a new add-on version
  with a changelog entry.
- FR-8.3 Sensible uninstall/reinstall behaviour: `/data` keeps sessions,
  memory and settings; a reset option exists.

### FR-9 Ecosystem awareness (added 2026-11-11)
- FR-9.1 Track Home Assistant releases, release notes, breaking changes and
  deprecations, new integrations, the app store catalog and HACS/community
  trends ("what's hot").
- FR-9.2 Warn the user before an update when a cached breaking change or
  deprecation affects their installed integrations, custom components or YAML.
- FR-9.3 Help choose functionality: given a need, return 2–3 fitting options
  with fit/effort/risk/maintenance trade-offs and cited sources + fetched dates;
  recommend, never install.
- FR-9.4 Be ready for change: refresh the local knowledge cache on a schedule,
  label stale knowledge, and keep the operating instructions current with
  Home Assistant terminology (apps vs add-ons).

### FR-10 Local-first cost control (added 2026-11-11)
- FR-10.1 Fetching, parsing, indexing, dedupe and compatibility matching run
  entirely inside the add-on (conditional HTTP + local cache/index), with **zero
  LLM calls** on that path.
- FR-10.2 The agent reads short cached excerpts and synthesises only on demand;
  raw pages and full inventories are never dumped into model context.
- FR-10.3 Local filesystem search and the collector are free of model cost; no
  external search API is required for routine knowledge work.


## 4. Non-functional requirements
- NFR-1 HAOS amd64 + aarch64; image reasonable size; offline operation after
  install (only LLM API and optional HA cloud endpoints).
- NFR-2 Memory footprint target ≤ 1 GB RSS; startup ≤ 60 s; no CPU spin loops.
- NFR-3 Survives add-on restart, HA restart, HAOS update, and backup restore.
- NFR-4 No dependency on a separately installed SSH add-on.
- NFR-5 Reproducible builds; versioned releases; CI that lints the add-on
  manifest and builds the image.

## 5. Out of scope for v0.1
- HA Container installations (no Supervisor) — documented as unsupported;
  direct-URL mode may come later.
- HA Assist voice pipeline / conversation agent registration.
- Multi-user HA auth mapping (ingress inherits HA user session).
- Cloud relay or remote access beyond HA's own ingress.
- Automatic merge/PR into the HA add-on store (custom repo only).
