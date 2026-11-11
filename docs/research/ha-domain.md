# DeepSeek Harness for Home Assistant — domain research and agent design

Status: design research for the HA add-on (2026-11-11). No live Home Assistant instance was available in this workspace, so every behavior claim is marked with its evidence class below. This document is the product brain: what the agent should do, which tools we implement, where the safety gates are, how monitoring behaves, and how the add-on builder loop works. Packaging (config.yaml, ingress wiring) and DSH container mechanics are owned by the sibling documents `ha-addon.md` and `dsh-container.md`; this document only states the capability requirements those documents must satisfy.

## Evidence classes used in this document

| Marker | Meaning |
|---|---|
| **[D]** | Documented. Fetched from official Home Assistant docs during this research (URL in [Sources](#sources)). |
| **[A]** | Assumed. Sane default or design choice consistent with the docs, but not directly stated; must be verified against a live HA before shipping. |
| **[U]** | Unverified. Internal/homeassistant command or behavior known from the frontend ecosystem but not in the public API reference. Treat as a hypothesis to test; every tool built on it needs a fallback. |

## Terminology note — read before writing any user-facing copy

Home Assistant's current contributor documentation and UI call **add-ons "apps"**, while the Supervisor API keeps the old names: paths stay `/addons` and `/store/addons`, and the config keys stay `hassio_api`/`hassio_role` ([Supervisor API intro](https://contributors.home-assistant.io/apps/supervisor-api/): "The paths still use the old name: apps live under `/addons`"). The 2026.11 UI shows **Settings → Apps**, **App store**, **Local apps**, and the config reference documents `homeassistant_config`/`local_apps`/`app_config` map types with `addon_*` accepted only as deprecated aliases. [D]

Implications:

- Internal engineering names stay as proposed here (`sup_*`, add-on, `/addons`) to match the API and the task brief.
- **User-facing agent copy must say "app"** (except when quoting an older guide), and UI paths must be the current ones: **Settings → Apps**, not "Settings → Add-ons". If we hardcode "add-on" in chat, we will confuse users on 2026.11+. Recommend one product label decision from the Lead; the skills in `skills-draft/` already write "app (add-on)" on first use and "app" afterwards. [A]
- Three other renames matter for generated YAML and for explaining errors: **services → actions** (`action:` in YAML; REST path still `/api/services`), **logbook → Activity** (panel name; API path still `/api/logbook`), and the automation keys `triggers:`/`conditions:`/`actions:` (plural at the top level; items keep singular `trigger:`/`condition:`/`action:`, `service:` → `action:` since 2024.8, `platform:` → `trigger:` since 2024.10). [D]

## Sources

Fetched and read during this research:

- REST API — https://contributors.home-assistant.io/core/internals/rest-api/ [D]
- WebSocket API — https://contributors.home-assistant.io/core/internals/websocket-api/ [D]
- Supervisor API overview (roles, envelope, logs, jobs) — https://contributors.home-assistant.io/apps/supervisor-api/ [D]
- Supervisor: apps endpoints — https://contributors.home-assistant.io/apps/supervisor-api/apps/ [D]
- Supervisor: store endpoints — https://contributors.home-assistant.io/apps/supervisor-api/store/ [D]
- Supervisor: backups — https://contributors.home-assistant.io/apps/supervisor-api/backups/ [D]
- Supervisor: Core + Core API proxy — https://contributors.home-assistant.io/apps/supervisor-api/core/ [D]
- Supervisor: Supervisor endpoints (updates, jobs, resolution) — https://contributors.home-assistant.io/apps/supervisor-api/supervisor/ [D]
- Supervisor: host and OS (disks, logs, network) — https://contributors.home-assistant.io/apps/supervisor-api/host/ [D]
- App configuration reference (`config.yaml` keys, map types, API access) — https://contributors.home-assistant.io/apps/reference/configuration/ [D]
- Your first app (tutorial) — https://contributors.home-assistant.io/apps/first-app/ [D]
- Add options (schema types, `/data/options.json`, `app_config`) — https://contributors.home-assistant.io/apps/guides/options/ [D]
- Test your app (local build, rebuild loop, logs) — https://contributors.home-assistant.io/apps/guides/testing/ [D]
- Automations in YAML — https://www.home-assistant.io/docs/automation/yaml/ [D]
- Troubleshooting automations — https://www.home-assistant.io/docs/automation/troubleshooting/ [D]
- Reload/restart/reboot — https://www.home-assistant.io/common-tasks/general/restarting/ [D]
- configuration.yaml, validating, reloading — https://www.home-assistant.io/docs/configuration/ [D]
- Recorder — https://www.home-assistant.io/integrations/recorder/ [D]
- Backup integration (backup actions, backup sensors) — https://www.home-assistant.io/integrations/backup/ [D]
- System Log — https://www.home-assistant.io/integrations/system_log/ [D]

Cited from the documented site structure but not re-fetched here (stable URLs; re-check before publishing): `/docs/configuration/yaml/`, `/docs/configuration/secrets/`, `/docs/configuration/splitting_configuration/`, `/docs/configuration/packages/`, `/docs/templating/`, `/integrations/template/`, `/integrations/notify/`, `/integrations/persistent_notification/`, `/integrations/logger/`, `/integrations/repairs/`, `/integrations/update/`, `/integrations/recorder/#action-purge`, `/common-tasks/general/backups/`, `/common-tasks/general/logs/`, `/dashboards/`, `/docs/automation/testing/`.

---

## 1. Design principles for the agent (the "product brain")

These principles are non-negotiable and are restated as guardrails in every skill draft.

1. **Read, then plan, then act, then verify.** Never write YAML, call a service, or restart anything without first reading the current state/config and stating a one-line plan. After every action, verify the result (state, logs, config check, job status) instead of assuming success. DSH's model-visible-equals-logged rule already gives us the audit trail; the agent must use it.
2. **Smallest change that solves the user's question.** Prefer one automation over a template over a custom integration over an add-on. Prefer reload over restart. Prefer a helper over a template sensor where the helper is the native concept. Say why the heavier option was rejected.
3. **The user's data is the ground truth, not the model's memory.** Entity IDs, service names, add-on slugs, options schemas, and versions are always fetched from the live instance. Never invent an entity id or action name; if a tool has no such data, ask or search.
4. **Reversibility is a feature you explain.** Every mutating tool produces a snapshot/backup and returns how to undo it. If an operation cannot be undone (full backup restore, uninstall with data removal), the agent must say so before doing it, using the risk template in §4.11.
5. **Explain like a maintainer, not like a manual.** Short answer first; then what changed; then what to check. Use the user's own names (friendly name + area), never raw JSON, unless the user is a developer who asked for it. One clarifying question at a time.
6. **Never break the house to fix a warning.** Restarts, updates, and automation edits that touch lights/locks/heaters are evaluated for blast radius before convenience. A monitoring warning that is safer left alone (e.g. an intermittent sensor) gets reported, not "fixed" by hiding or deleting it.
7. **Stay inside the four capabilities the user granted.** HA API, config files, app management, app scaffolding. Anything outside (SSH to the host, editing `.storage`, wiping the data disk, Docker socket) is refused with a pointer to the right UI.

8. **Keep institutional memory and backups current.** At the start of work, read what we already know (`memory_get`); when something durable changes or is learned, record it (`memory_update`). Before any risky change, make sure a verified backup exists and tell the user which one it is. Memory and backups are how the agent stays useful and safe across conversations (§4.13, §6).

9. **Look ahead, not just at the screen.** Keep the local knowledge cache warm (release notes, breaking changes, store catalog) so you can warn about an update or recommend fitting functionality before the user asks. Fetch and index locally, synthesise only on demand, cite sources, and label stale data (§7).

Job routing between skills:

| User says | Skill |
|---|---|
| "why is this light unavailable", "my automation doesn't run", "check my logs" | `home-assistant-diagnostics` |
| "create an automation", "add a template sensor", "make a dashboard card", "convert this to YAML" | `home-assistant-config` |
| "is everything healthy", "watch my system", "daily summary", "alert me when…" | `home-assistant-monitor` |
| "what changed in the new release", "will the update break anything", "anything new?" | `home-assistant-monitor` (ecosystem watcher playbook) |
| "is there an app for…", "what should I install", "what would you recommend" | `home-assistant-addon-builder` (recommendation playbook) |
| "install an app", "update X", "build me an app that…", "back up before I update" | `home-assistant-addon-builder` (app management/backup playbooks) |

---

## 2. Job catalogue

Each job lists: intents, data the agent needs, HA/Supervisor calls, success criteria, and the typical failure that turns it into a diagnostics job. Tool names are the canonical names defined in §3.

### 2.1 Daily health and monitoring

**User intents.** "Is my system OK?"; "anything broken overnight?"; "notify me when something breaks"; "why did my dashboard show everything unavailable this morning?"; "is my backup still running?"

**Data needed.** HA version and config (`/api/config`), core state and recorder migration state (`/api/core/state`), entity states and entity registry, error log (`/api/error_log`, system log), repairs, host disk (`/host/info`), Supervisor/system info and resolution (`/supervisor/info`, `/resolution/info`), available updates (`/available_updates`), backup list and staleness (`/backups/info`), app states (`/addons`). [D]

**Calls.** Cheap probe: `GET /api/`, `GET /api/core/state`, `GET /api/states` (filtered), `GET /host/info`, `GET /backups/info`, `GET /available_updates`. Deep probe adds `GET /api/error_log`, system log structured list, `GET /resolution/info`, `GET /addons`. Digest sends one `notify_user` (persistent notification + optional `notify.send_message`). [D]

**Success criteria.** Probe completes in <10 s with no writes, returns a severity-scored finding list, and produces at most one notification per new finding. Digest is ≤20 lines, names the top 3 issues, and every claim is traceable to a fetched value. No false "all good" when core is unreachable: if core is unreachable, the probe fails loudly rather than reporting zero findings. [A]

**Typical failure mode.** The monitor becomes noise: it reports the same intermittent entity every run, users mute it, and a real outage is missed. Mitigation is the dedup/quiet-hours design in §5.

### 2.2 Diagnose integration / entity / automation problems

**User intents.** "The living-room light is unavailable and the dashboard shows a triangle"; "my automation didn't fire this morning"; "the log is full of errors after the update"; "which automation turned off my heater?"; "I renamed a device and now things are broken".

**Data needed.** Current state + attributes of the entity and its neighbours, entity/device/area registry (platform, disabled, hidden, device id), history and logbook around the incident, automation list with `last_triggered`, automation trace of the failing run, error log and system-log entries for the integration/platform, repairs list, recently changed YAML files (our snapshot history), HA version and release notes when the symptom is "after update". [D]/[A]

**Calls.** `ha_get_state`, `ha_get_states`, `ha_list_registry`, `ha_get_history`, `ha_get_logbook`, `ha_list_automations`, `ha_get_automation_trace`, `ha_get_error_log`, `ha_get_system_log`, `ha_get_repairs`, `ha_get_config_check`, `ha_render_template` (to test the exact template in a trace), plus `config_search`/`config_read` to find where the entity/automation is referenced. [D]

**Success criteria.** A diagnosis states: symptom → evidence (log line / trace step / state value) → cause class → proposed fix → confidence. The fix is a concrete edit or an explicit "this is device-side, contact/repair the device", never a guess. If evidence is insufficient, the agent says which single extra data point would decide it and how to get it.

**Typical failure mode (documented, worth teaching the agent).** "State changed trigger didn't fire" is usually one of: automation disabled; `from:` state did not match because the entity went `unavailable` in between; the compared value was the UI label (`Open`) not the raw state (`on`); `for:` timer restarted; a running automation in `single` mode logged `Already running`; or the entity ID changed after a rename and the automation still references the old ID. [D] The agent should walk this list before touching YAML.

### 2.3 Configure YAML (automations, scripts, templates, helpers, dashboards)

**User intents.** "Turn on the porch light at sunset when someone is home"; "make a template sensor for the average of three temperatures"; "add a helper button that runs my vacuum"; "convert this UI automation to YAML"; "make this notification only during the night"; "put a card on my dashboard".

**Data needed.** Existing `configuration.yaml` and include files (respect `!include*` and `packages:` so edits land in the right file), existing `automations.yaml` (must stay a list; UI-managed), entity registry for real entity IDs and states, available actions (`GET /api/services`) for exact action names and field schemas, existing helpers, templates rendered with current values, dashboards mode (YAML vs storage). [D]/[A]

**Calls.** `config_search`/`config_read`, `ha_list_registry`, `ha_get_services`, `ha_render_template`, `config_write`/`config_edit`, `ha_get_config_check`, `ha_reload` (scoped reload where possible; `homeassistant.reload_all` only when several domains changed). Dashboards: YAML-mode dashboards via `config_*`; storage-mode dashboards need `ha_save_dashboard` [U]. [D]/[A]

**Success criteria.** Config check returns `valid`; only the intended files changed (diff shown to the user); the new automation fires when triggered or is explicitly verified by a manual `automation.trigger` test; templates render to the expected value with real state; reload (not restart) was enough, or the agent told the user a restart is required and why. A snapshot exists to undo the edit.

**Typical failure mode.** Old and new automation keys mixed: `triggers:` plus `trigger:`, or an item starting with `- actions:`. Home Assistant either silently drops the old-key block when saving in the editor, or refuses setup with `Cannot specify both 'trigger' and 'triggers'`. The agent always emits the current singular/plural form and never both. [D]

### 2.4 Manage add-ons (apps): install, update, configure, logs

**User intents.** "Install Mosquitto"; "update the ESPHome app"; "the app won't start, show me the logs"; "change the port of my app"; "stop the app while I work on the network"; "which apps have updates?"

**Data needed.** Installed apps with state/version/update_available, app details (options, schema, boot, ingress, ports, resource usage), store catalog with availability (arch/machine/HA-version constraints), changelog/documentation of the target version, app logs and Supervisor logs, security rating, protection mode, auto_update/watchdog flags, host disk free space. [D]

**Calls.** `sup_list_addons`, `sup_get_addon`, `sup_get_store`, `sup_addon_logs`, `sup_get_logs` (Supervisor log for config errors), `sup_get_updates`, `sup_addon_install`/`sup_addon_update` (background job + `sup_job_status`), `sup_addon_start`/`sup_addon_stop`/`sup_addon_restart`, `sup_set_addon_options`, `sup_addon_rebuild` (local apps only), `sup_core_update` (HA update), `ha_get_history` to verify downstream entities recovered. [D]

**Success criteria.** The app reaches `started` after the operation; its own entities come back (checked via `ha_get_states` for its known entities); logs contain no new fatal error in the first start; a backup exists before update when the user asked for one (Supervisor's update endpoint supports `backup: true`). [D]/[A]

**Typical failure mode.** "Update doesn't apply": for a locally built app the version in `config.yaml` was not raised, and the Supervisor will not offer an update; forgetting `image:` commented out during local development means the Supervisor pulls the published image instead of rebuilding. [D]

### 2.5 Build a new local app

**User intents.** "I need a small web page that shows the solar forecast"; "make an app that polls my heat pump's HTTP API and exposes it to HA"; "scaffold an app I can then extend myself".

**Data needed.** Requirements form answers (§8.1), target architecture (`/info.arch`, `supported_arch`), HA base image tag used by current apps, `local_apps` folder path, Supervisor log access, app security model (ports vs ingress, privileged capabilities, `homeassistant_api`, `hassio_api` role), backup policy for local apps. [D]

**Calls.** `addon_scaffold` (writes files), `addon_validate` (lint), `config_read` (inspect generated files), `sup_store_reload`, `sup_addon_install` (slug `local_<slug>`), `sup_job_status`, `sup_addon_logs`, `sup_get_logs`, `sup_addon_rebuild` (`force: true` during development), `sup_addon_start`. [D]/[A]

**Success criteria.** `config.yaml` is accepted by the Supervisor (the app appears under **Local apps** after **Check for updates**), the image builds, the app starts, the user-visible function works (page loads / entities appear), and the remaining loop is documented for the user (how to rebuild after an edit, where the logs are, how to publish). [D]

**Typical failure mode.** Build/start failures are nearly always: invalid YAML in `config.yaml` (app never appears), CRLF line endings in `run.sh` (script fails with a confusing error), `init:` wrong for the base image (S6 does not start), or the version not bumped (update not offered). See §8.5 and §9.

### 2.6 Backups and recovery

**User intents.** "Back up before I update HA"; "when was my last backup?"; "I need to restore my config after breaking YAML"; "my backup is on a NAS"; "I deleted an automation, can we get it back?"

**Data needed.** Backup list with dates/types/size/locations, backup settings (`days_until_stale`), automatic-backup sensors/state, HA and app versions inside a backup, free disk space, whether a backup/restore job is running, the local snapshot history for single-file rollback. [D]/[A]

**Calls.** `sup_backup_list`, `sup_backup_create` (full/partial: `homeassistant`, `folders`, `addons`, `name`, `background`), `sup_job_status`, `sup_backup_restore` (full/partial, **destructive**), `config_snapshot`/`config_restore` (single-file rollback), `ha_get_config_check` after a partial config restore. [D]

**Success criteria.** A new backup appears in the list with the expected contents before the risky operation begins (verify with the job and the list, not the HTTP 200 alone); restore paths are explained with what will be overwritten; single-file recovery is preferred over full restore. [D]/[A]

**Typical failure mode.** Restore while a DB migration or another backup runs (Supervisor rejects or users lose progress); restoring a full backup silently downgrades newer config; assuming a backup exists because automatic backups are enabled (verify the newest backup date, not the setting). [A]

### 2.7 Updates and version housekeeping

**User intents.** "What updates are available?"; "update everything safely"; "I'm on an old HA version, what did I miss?"; "should I update or wait?"; "which apps auto-update?"

**Data needed.** `GET /available_updates` (core/supervisor/os/apps with versions), `/core/info`, `/os/info` (pending version waits for reboot), `/supervisor/info` (channel), app `update_available`/`auto_update`, release notes/changelog (`/store/addons/<app>/changelog`, release blog for core), breaking changes, backup freshness, disk space, `breaking_versions` on apps. [D]

**Calls.** `sup_get_updates`, `sup_get_info`, `sup_get_addon`, `sup_get_store`, `sup_core_update` (with `backup: true`), `sup_addon_update` (with `backup: true` when supported), `sup_backup_create`, `ha_restart`/`sup` OS reboot paths (OS update needs a host reboot), `sup_job_status`, `sup_addon_logs` for post-update health. [D]

**Success criteria.** Each update has a verdict (safe now / needs backup / wait) with reasons; backup is verified before core updates; after the update, the core is running the new version (`/api/config.version`), the previously broken/regressed entities are checked, and the user is told what to watch. [A]

**Typical failure mode.** Updating Core while a recorder DB migration is in progress or a backup is running: the Supervisor refuses, or the update restarts into a slow migration; the UI shows "Wait and restart" during backups. [D]

### 2.8 Ecosystem awareness, compatibility, recommendations

**User intents.** "What changed in the new Home Assistant release?"; "will my stuff break if I update?"; "is there an app for my heat pump?"; "anything new I should know about?"; "what's a good way to do X?"

**Data needed.** Normalized release records and breaking-change rules in the local knowledge index (§7), installed integrations and custom components, YAML feature usage, store catalog, update availability, backup freshness before an update.

**Calls.** `ha_news_scan` (deterministic fetch/parse/index), `ha_news_digest`, `knowledge_search`, `ha_compat_scan`, `ha_recommend`, `sup_get_updates`, `sup_get_store`, `ha_get_config`, `config_search`. No external search or LLM call is required for fetching or matching.

**Success criteria.** Every claim cites a source URL and fetch date; compatibility findings name the affected integration/entity/automation count and the release in which the change lands; recommendations present 2–3 options with fit/effort/risk/maintenance and never install anything during the recommendation. A stale or offline cache is labelled, not hidden.

**Typical failure mode.** Alerting on every upstream release or every GitHub star change (noise), or recommending HACS/custom integrations without saying they are community-supported. Mitigation: seen/dedup state, weekly cadence, and the "native first, label unofficial" ordering in §7.7.

---

## 3. Tool surface proposal

Design rules:

- One tool = one user-visible capability, named by domain prefix: `ha_*` (Home Assistant Core), `sup_*` (Supervisor/system), `config_*` (config filesystem), `addon_*` (builder), `monitor_*`, `notify_user`.
- Tools wrap exactly one documented endpoint or one small fixed sequence; every result carries the endpoint(s) used and a `redacted` flag.
- Everything read-only is safe; every mutating tool carries a class (§4.1) and supports the approval protocol (§4.2).
- Tools are mounted in capability groups so `read_only` / `monitor_only` profiles expose a small, safe catalog. The canonical names below are what the skills and the real plugin must use.

### 3.1 Runtime base URLs and authentication

The app runs inside the Supervisor network and uses its own `SUPERVISOR_TOKEN`; no long-lived HA token is needed. [D]

| Surface | Base URL | Requirement |
|---|---|---|
| HA Core REST proxy (acts as HA administrator) | `http://supervisor/core/api` | `homeassistant_api: true` [D] |
| HA Core WebSocket proxy | `ws://supervisor/core/websocket` | `homeassistant_api: true` [D] |
| Supervisor API | `http://supervisor` | `hassio_api: true` + role [D] |
| Config files | `/config` (`homeassistant_config` map, rw) | map option [D] |
| Local apps folder | `/addons` (`local_apps` map, rw) | map option, needed by `addon_*` [D] |
| Add-on public config | `/config` (`app_config` map) | optional; note `/config` here is *our app's* config folder, not HA's config [D] |

Role choice matters: `hassio_role: manager` is enough for app/store/backup/core/host/resolution endpoints, and `admin` is **not** needed. [D] The Core proxy always acts as an HA administrator, so HA itself cannot constrain our writes per user; **read-only must be enforced by the plugin, not by HA** (§4.1). [D]

### 3.2 Canonical result envelope

Every tool returns the same outer shape so the model can reason about failures uniformly:

```jsonc
{
  "ok": true,
  "summary": "one line for the model and the UI card",
  "data": { /* tool-specific canonical output, below */ },
  "warnings": [{ "code": "STALE_DATA", "message": "..." }],
  "meta": {
    "source": ["GET /api/states"],
    "fetched_at": "2026-11-11T10:00:00+01:00",
    "redacted": false,
    "truncated": false
  }
}
```

Errors: `{ "ok": false, "error": { "code": "NOT_FOUND|STALE_BASE|FORBIDDEN|UNSUPPORTED|UPSTREAM_ERROR|NEEDS_APPROVAL", "message": "...", "hint": "next safe action", "retryable": false } }`. The model must never retry a `FORBIDDEN` call; on `NEEDS_APPROVAL` it follows §4.2. [A]

### 3.3 HA Core — read tools (class R)

| Tool | Params | Wraps | Canonical output |
|---|---|---|---|
| `ha_get_config` | `sections[]` (`core`, `state`, `components`) | `GET /api/config`, `GET /api/core/state`, `GET /api/components` [D] | version, location_name, time_zone, unit_system, components count, core_state, recorder migration flags |
| `ha_get_states` | `domain[]`, `entity_ids[]`, `area_id`, `include_attributes=false`, `limit=200` | `GET /api/states` [D] (+ registry for area filter [A]) | `{count, by_domain, states:[{entity_id,state,attributes?,last_changed,last_updated}]}` |
| `ha_get_state` | `entity_id` | `GET /api/states/<id>` [D] | state object + friendly_name + area/device (via registry) |
| `ha_get_services` | `domain[]`, `query` | `GET /api/services` [D] | `{domains:[{domain, services:[{service, name, description, fields}]}]}` — the canonical action catalog used before any call |
| `ha_list_registry` | `kind: entities\|devices\|areas`, filters (`domain`, `platform`, `area_id`, `disabled`, `hidden`) | WS `config/entity_registry/list`, `config/device_registry/list`, `config/area_registry/list` [U: command names used by the frontend; registry endpoints are not in the public WS page] with fallback to states + `.storage` read is **not** allowed | entities: `{entity_id,name,platform,device_id,area_id,disabled_by,hidden_by,category}`; devices/areas analogous |
| `ha_get_history` | `entity_ids[]`, `start`, `end`, `minimal=true` | `GET /api/history/period/<ts>` [D] | per-entity change list (state, last_changed) |
| `ha_get_logbook` | `entity_ids[]`, `start`, `end`, `period` | `GET /api/logbook/<ts>` [D] | entries with when/name/message/context |
| `ha_get_error_log` | `lines=100`, `grep` | `GET /api/error_log` (Admin) [D] | text tail + extracted `{level,logger,message}` lines [A] |
| `ha_get_system_log` | `level`, `limit=50`, `since` | WS `system_log/list` [U] with `GET /api/error_log` fallback [D] | structured `{level,source,name,message,exception,timestamp}` — system_log keeps only the last 50 entries in the condensed log by default [D] |
| `ha_get_repairs` | `include_ignored` | WS `repairs/list_issues` [U] | `{issues:[{domain,issue_id,severity,translation_key,created,is_ignored}]}` — no documented REST equivalent [U] |
| `ha_list_automations` | `include_scripts`, `include_scenes` | derived: entity registry (domain `automation`/`script`/`scene`) + `GET /api/states` attributes (`last_triggered`, `mode`, `current`) [A]; YAML source from config files when needed | `{automations:[{entity_id,alias,state,last_triggered,id,mode,runs_today?}], unmapped_yaml:[...]}` |
| `ha_get_automation_trace` | `entity_id` or `automation_id`, `run_id?`, `limit=1` | WS `trace/list` + `trace/get` [U]; fallback: if the trace store is unreadable, return `UNSUPPORTED` with the UI path **Settings → Tools → Traces** | `{run:{started,finished,trigger,condition_results,action_results,error,steps:[{path,result,error,variables_excerpt}]}}` |
| `ha_render_template` | `template`, `variables`, `entity_id?` | `POST /api/template` (Admin) [D]; WS `render_template` also exists [D] | `{rendered, is_static?, error?}` |
| `ha_get_config_check` | — | `POST /api/config/core/check_config` (Admin) [D]; Supervisor `POST /core/check` as alternative [D] | `{result: valid\|invalid, errors, warnings}` |

### 3.4 HA Core — action tools (mutating)

| Tool | Params | Wraps | Class | Notes |
|---|---|---|---|---|
| `ha_reload` | `targets[]` (`all`, `core_config`, `automations`, `scripts`, `scenes`, `templates`, `themes`, `input_helpers`, `frontend`) [A for exact keys] | `POST /api/services/homeassistant/reload_all` or the per-domain reload action, e.g. `automation.reload` [D]; verify the exact action set from `ha_get_services` before use | ACT | Admin-only action; reload does not restart. Quick reload reloads integrations that support it, core config, themes and custom templates [D] |
| `ha_call_service` | `domain`, `service`, `data`, `target` (entity_id/device_id/area_id/floor_id/label_id), `return_response=false` | `POST /api/services/<domain>/<service>` (+`?return_response`) [D] | ACT / DIS / DES by catalogue | Target resolution via WS `extract_from_target` when `target` is used [U]. Deny-list in §4.7 |
| `ha_restart` | `mode: restart\|safe_mode`, `force=false`, `reason` | Supervisor `POST /core/restart` [D] (preferred: returns state, supports safe mode) or service `homeassistant.restart` [D] | DIS | Check migration + backup state first (§4.5) |
| `ha_get_dashboard` | `url_path` | WS `lovelace/config` [U] | R | *(extended)* storage-mode dashboard read |
| `ha_save_dashboard` | `url_path`, `config`, `base_sha256` | WS `lovelace/config/save` [U] | SW | *(extended)* storage dashboards; YAML-mode dashboards go through `config_*` instead [A] |

### 3.5 Supervisor / system tools

| Tool | Params | Wraps | Class | Canonical output |
|---|---|---|---|---|
| `sup_get_info` | `sections[]` (`system`, `supervisor`, `core`, `host`, `os`, `network`) | `GET /info`, `/supervisor/info`, `/core/info`, `/host/info`, `/os/info`, `/network/info` [D] | R | versions, channel, healthy, host disk `{disk_free,disk_total,disk_used,disk_life_time}` [D], internet flags, arch, machine, timezone, core port |
| `sup_get_resolution` | `include_checks=false` | `GET /resolution/info` [D] | R | unsupported/unhealthy reasons, issues, suggestions |
| `sup_get_updates` | — | `GET /available_updates` [D] | R | `{updates:[{update_type:core\|supervisor\|os\|addon,name,version_latest}]}` |
| `sup_list_addons` | `include_stats=false` | `GET /addons` [D] | R | apps with slug,state,version,version_latest,update_available,repository,boot,watchdog |
| `sup_get_addon` | `slug`, `include_options=false` | `GET /addons/<slug>/info` [D] | R | info model; options only for `self`/own app or with explicit user need, and password-like fields redacted [D/A] |
| `sup_set_addon_options` | `slug`, `options`, `boot?`, `watchdog?`, `network?`, `validate=true` | `POST /addons/<slug>/options/validate` then `POST /addons/<slug>/options` [D] | SW | applied options; note changes take effect on next start [D] |
| `sup_addon_logs` | `slug`, `lines=100`, `verbose=false`, `previous_boot=false` | `GET /addons/<slug>/logs` (+`/logs/latest`, `/logs/boots/-1`) [D] | R | text tail, ANSI stripped, truncated at N KB |
| `sup_addon_start` / `sup_addon_stop` / `sup_addon_restart` | `slug`, `wait=true` | `POST /addons/<slug>/start\|stop\|restart` [D] | ACT (start/stop of a dependency → DIS) | final state; start/restart wait until running [D] |
| `sup_addon_install` | `store_slug`, `background=true` | `POST /store/addons/<slug>/install` [D] | DIS | job id; availability pre-checks via `/store/addons/<slug>/availability` [D] |
| `sup_addon_update` | `slug`, `backup=true`, `background=true` | `POST /store/addons/<slug>/update` [D] | DIS | job id; an app cannot update itself [D] |
| `sup_addon_uninstall` | `slug`, `remove_config=false` | `POST /addons/<slug>/uninstall` [D] | DES | job/empty data; irreversible for app data [D] |
| `sup_addon_rebuild` | `slug`, `force=false` | `POST /addons/<slug>/rebuild` [D] | DIS | local-build loop only |
| `sup_get_store` | `query`, `installed=false`, `available_only=true` | `GET /store`, `/store/addons`, `/store/addons/<slug>`, `/availability` [D] | R | store catalog with installed/available flags, security rating, arch |
| `sup_store_reload` | — | `POST /store/reload` [D] | SW | picks up new versions and local app folders [D] |
| `sup_get_logs` | `target: supervisor\|core\|host`, `identifiers`, `boot`, `lines=200` | `GET /<target>/logs` variants [D] | R | text; Supervisor log is where invalid app `config.yaml` shows up [D] |
| `sup_backup_list` | `include_settings=true` | `GET /backups/info` [D] | R | backups with date,type,size,locations,content + `days_until_stale` [D] |
| `sup_backup_info` | `slug` | `GET /backups/<slug>/info` [D] | R | one backup: slug,type,name,date,size,compressed,protected,locations,homeassistant version,addons,repositories,folders,extra [D] |
| `sup_backup_create` | `mode: full\|partial`, `name`, `homeassistant=true`, `folders[]`, `addons[]`, `background=true`, `password?` | `POST /backups/new/full\|partial` [D] | SW (full = DIS-ish but safe) | `{job_id, slug}` |
| `sup_backup_restore` | `slug`, `mode: full\|partial`, `homeassistant`, `addons[]`, `folders[]`, `background=true` | `POST /backups/<slug>/restore/full\|partial` [D] | DES | job id; core and apps restart during restore [D] |
| `sup_job_status` | `job_id`, `wait=false`, `timeout_s=120` | `GET /jobs/<job_id>` [D] | R | `{done, progress, stage, errors[], child_jobs[]}` |
| `sup_core_update` | `version?`, `backup=true`, `background=true` | `POST /core/update` [D] | DIS | job id; fails during migration [D] |

### 3.6 Config filesystem tools

Our add-on mounts HA's config folder read/write. These tools are the **only sanctioned way** to change it; raw filesystem writes bypass validation and snapshots (§8 open question on enforcement).

| Tool | Params | Returns / side effects | Class |
|---|---|---|---|
| `config_list` | `path="/"`, `depth=2`, `include_hidden=false` | files dirs with size/mtime; hard-denies `.storage/`, `*.db*`, `deps/`, `tts/`, `.cloud/` [A] | R |
| `config_read` | `path`, `max_bytes=65536`, `start_line?`, `end_line?` | content + `sha256` + `lines`; `!secret` references are shown as written (never resolved) [D secrets are references] | R |
| `config_search` | `query` (regex), `glob="*.yaml"`, `path="/"`, `max_results=50` | matches with file:line, redacted [A] | R |
| `config_write` | `path`, `content`, `base_sha256?` (required when file exists), `snapshot=true`, `validate=true` | writes atomically, creates `.dsh-backups/<ts>/`, runs config check, auto-restores on invalid, returns diff + check result | SW |
| `config_edit` | `path`, `old_string`, `new_string`, `base_sha256`, `validate=true` | targeted edit with the same guarantees as `config_write` | SW |
| `config_delete` | `path`, `base_sha256`, `snapshot=true` | moves file to snapshot then unlinks; refuses `configuration.yaml`, `secrets.yaml`, `automations.yaml` without extra `allow_core_files=true` | DES |
| `config_snapshot` | `paths[]`, `label` | tar+manifest under `/data/config-backups/<ts>/`; returns snapshot id | SW |
| `config_restore` | `snapshot_id` or `path`+`ts` | restores, then runs config check; returns diff | SW |

### 3.7 Add-on builder tools

| Tool | Params | Behavior | Class |
|---|---|---|---|
| `addon_scaffold` | `name`, `slug`, `description`, `purpose`, `version="1.0.0"`, `arch=["aarch64","amd64"]`, `expose: ingress\|port\|none`, `port`, `ingress_port=8099`, `options`, `schema`, `hardware: none\|serial\|usb\|gpio`, `needs_ha_api`, `needs_supervisor_api`, `base_image="ghcr.io/home-assistant/base:3.24"`, `language: bash\|python\|node` | creates `/addons/<slug>/` with the file set in §8.2; refuses to overwrite without `overwrite=true`; validates before returning | SW |
| `addon_validate` | `slug` | runs the lint checklist in §8.3 against `config.yaml`, `Dockerfile`, `run.sh` (LF check), translation files; returns `{errors[], warnings[], security_rating_impact, available: bool}` | R |
| `addon_build` | `slug`, `mode: install\|rebuild`, `force=true`, `wait=true`, `timeout_s=600` | `sup_store_reload` → (`sup_addon_install` or `sup_addon_rebuild`) → `sup_job_status` poll → on failure fetch `sup_get_logs` + `sup_addon_logs`; returns `{state, job_id, logs_tail, next_action}` | DIS |

### 3.8 Agent memory and knowledge tools

Persistent memory (§6) is what makes the agent useful across conversations: the user should not re-explain their house every day, and the agent must remember what it changed and which backups exist.

| Tool | Params | Behavior | Class |
|---|---|---|---|
| `memory_get` | `sections[]` (`inventory`, `changes`, `quirks`, `preferences`, `backups`, `all`), `fresh=false` | returns `{revision, collected, curated, stale[], changed_since_last_session}`; `fresh=true` re-collects deterministic sections first | R |
| `memory_refresh` | `scope: full\|inventory\|integrations\|backups` | deterministic re-collection from HA/Supervisor (no LLM): versions, components, entity counts, automations, apps, backups, config inventory; returns a diff against the previous snapshot | R (writes only `/data/memory`) |
| `memory_update` | `ops[]` (`set`, `append`, `add_quirk`, `resolve_quirk`, `record_change`, `record_backup`), `reason`, `base_revision` | atomic patch of curated sections, appends `changelog.jsonl`; refuses to modify collected sections; returns the new revision | SW |

Rule: every skill opens with `memory_get` (cheap, cached) and a successful mutation ends with `memory_update(op: record_change)`; a resolved incident that revealed a durable quirk ends with `add_quirk`. Memory is a cache of observed facts, never an authority: live tool results win and the correction is recorded (§6.9).

Knowledge and anticipation tools (fetch/parse/index locally, §7):

| Tool | Params | Behavior | Class |
|---|---|---|---|
| `ha_news_scan` | `sources[]`, `force=false` | deterministic fetch → parse → index of the §7.2 sources; returns `{new_items, since, sources_checked, cache_hits, stale[]}`; **0 LLM calls** | R |
| `ha_news_digest` | `window_days=7`, `synthesize=false` | deterministic "what's new" digest from the index; `synthesize=true` permits one LLM call to phrase it; never pastes pages | R |
| `knowledge_search` | `query`, `k=5`, `sources[]`, `since`, `max_excerpt=600` | FTS5 BM25 over the local index; returns `{hits:[{title,url,published_at,fetched_at,section,excerpt}]}` and never full pages | R |
| `ha_compat_scan` | `target` (`upcoming`, `{kind:"core",version}`, `{kind:"app",slug}`) | deterministic match of known breaking changes/deprecations against installed integrations, custom components and YAML usage; findings carry severity, affected count, evidence URL, remediation | R |
| `ha_recommend` | `need`, `constraints`, `k=3` | local retrieval + scoring (fit/effort/risk/maintenance) on the knowledge index, store catalog and inventory; at most one phrasing call; returns options with tradeoffs and sources; never installs | R |

### 3.9 Monitoring and notification tools

| Tool | Params | Behavior | Class |
|---|---|---|---|
| `monitor_probe` | `deep=false` | runs the signal set in §5.1, updates state, returns findings (no notifications unless `notify=true`) | R (writes only `/data/monitor/state.json`) |
| `monitor_digest` | `send=true`, `window_h=24` | builds the digest (§5.5) and sends `notify_user` if there is anything to report | ACT (notification) |
| `monitor_configure` | `get` or `set` object (thresholds, quiet hours, digest time, notify target) | reads/writes monitor settings in `/data/monitor/config.json` | SW |
| `monitor_history` | `since`, `severity_min=1`, `limit=50` | recent findings from `/data/monitor/findings.jsonl` | R |
| `notify_user` | `title`, `message`, `severity: info\|warning\|serious\|critical`, `persistent=true`, `notification_id?`, `target?`, `dedupe_key?` | `POST /api/services/persistent_notification/create` [D] and, when configured, `notify.send_message` with `target: {entity_id: notify.<x>}` [D]; honours quiet hours unless critical | ACT |

### 3.10 WebSocket-only operations and why they matter

Some high-value diagnostics are not in the documented REST API. The plugin should keep one multiplexed WebSocket connection to `ws://supervisor/core/websocket` for: automation traces (`trace/list`, `trace/get`), structured system log (`system_log/list`), repairs (`repairs/list_issues`), registry lists, template rendering with variables, target resolution (`extract_from_target`), and (extended) Lovelace config. [U]/[A] The public WS reference explicitly says integration commands are not all listed there — "the frontend source is the best place to see how they are called" — so these commands are a compatibility risk: every one needs a graceful `UNSUPPORTED` fallback and a version check (`auth_ok.ha_version` gives the HA version at connect time [D]).

### 3.11 Excluded operations (never expose, even with confirmations)

| Excluded | Why |
|---|---|
| `POST /api/states/<id>`, `DELETE /api/states/<id>`, `POST /api/events/<type>`, `GET /api/stream` | Fake states/events pollute the recorder and lie to the user; the REST docs warn state writes are overwritten by the next update [D]. Fire-event only for developers, behind an explicit developer profile if ever. [A] |
| `/os/datadisk/wipe`, `/os/datadisk/move`, `/os/boot-slot`, `/supervisor/repair`, `/jobs/options` (`ignore_conditions`), `/docker/reset-storage` | Destructive to the installation, or disables Supervisor safety conditions [D] |
| `/os/ssh/authorized_keys`, `/auth/*`, `/security/options` | Host access, credential checks, security-posture changes; Core-only or admin-scope escalation [D] |
| `/addons/<other>/security` (protection mode), `/addons/<other>/sys_options` | admin-only / Core-only, and silently weakens another app's sandbox [D] |
| Reading `.storage/`, `secrets.yaml` values, `/data/options.json` of other apps, HA user tokens | Secrets; `.storage` is runtime-managed and editing breaks integrations [D/A]. Our manager role *can* see other apps' options (they can hold passwords) [D] — the tool must redact and the skill must refuse |
| `homeassistant.restart/stop`, `hassio.*`, `shell_command.*`, `python_script.*`, `pyscript.*` **as raw service calls** | Restart is a dedicated gated tool; the rest are arbitrary code execution behind a service-call API. The agent may still call the *safe* parts of `hassio.*` through dedicated `sup_*` tools [A] |
| Editing UI-managed `automations.yaml` by hand while the UI owns it | Docs: `automations.yaml` is managed by the UI and should not be edited manually; use the editor API or YAML automations in `configuration.yaml` [D] |

---

## 4. Safety and approval model

### 4.1 Operation classes

| Class | Meaning | Examples | Default policy |
|---|---|---|---|
| **R** Read | No side effects on HA | states, logs, history, registry, backups list, app info | always allowed |
| **SW** Safe write | Reversible with a snapshot; scoped to files/own settings | `config_write`, `config_edit`, snapshots, own monitor settings, app options for non-critical apps | allowed; show diff; snapshot by default |
| **ACT** Act | Real-world effect, usually reversible | `ha_call_service` (lights, scripts, notifications), `ha_reload`, add-on start/stop, app options change | allowed for non-safety domains; confirm for safety domains |
| **DIS** Disruptive | Service interruption or version change | HA restart, core/app update, add-on install/rebuild, full backup restore *(DES)* | requires approval token; backup when data changes |
| **DES** Destructive | Hard or impossible to undo | add-on uninstall with config removal, full backup restore, `config_delete` of core files, core update (downgrade impossible) | requires approval token + explicit backup + user-stated intent |
| **X** Forbidden | Excluded surfaces | §3.11 | tool absent from catalog |

Safety domains needing per-call confirmation: `lock`, `alarm_control_panel` (disarm), `cover` (garage/valves), `valve`, `siren`, `camera` (privacy), `climate` extreme setpoints, `homeassistant` restart/stop, `hassio` calls, and anything whose target is a whole area/floor "all" when it includes safety domains. [A]

### 4.2 Approval protocol (dry run + token)

Every DIS/DES tool supports `dry_run: true`. In dry-run it performs no mutation and returns:

```jsonc
{
  "ok": true,
  "data": {
    "plan": "Restart Home Assistant Core",
    "blast_radius": "HA unavailable ~60-120 s; 3 running automations are interrupted; apps keep running",
    "reversible": "yes, service comes back; use safe_mode_restart if it does not",
    "backup": { "required": true, "suggested": "sup_backup_create partial homeassistant" },
    "confirmation_token": "dsh_conf_01J...",
    "expires_at": "2026-11-11T10:05:00+01:00"
  }
}
```

The real call must pass `confirmation_token`. The token is bound to `(tool, params hash, session)`, expires in 5 minutes, and is single-use. [A]

When `approval_mode: ask` (default), the agent must present the plan to the user in chat and wait for an explicit yes before using the token; it must not call the mutating tool in the same turn as the dry run unless the user's request already contained an unambiguous "do it". For unattended/monitor runs, DIS/DES never run: the finding is reported and the digest suggests the action. [A]

### 4.3 Read-before-write (optimistic concurrency)

`config_read` returns `sha256`. `config_write`/`config_edit` require `base_sha256` matching the current file; a mismatch returns `STALE_BASE` with a fresh read hint. Rationale: the HA UI (or another editor app, or the user) may edit the file between the agent's read and write, and blind overwrites are how configs get destroyed. [A] This mirrors the DSH filesystem version guard; implement it in the plugin, not just in prompt text.

### 4.4 Backup-before-change

- `config_write`/`config_edit`/`config_delete` snapshot the file first (unless `snapshot: false`, which the agent should never set for user files).
- Before a restart or core update: require a snapshot created in the last 15 minutes or a fresh `sup_backup_create` (partial, `homeassistant: true`), depending on scope; the Supervisor supports `backup: true` directly on `/core/update` and app update [D].
- Before an app uninstall with `remove_config: true`: list the app's public config folder and confirm the user understands it is deleted [D].
- Retention: last 20 snapshots, then prune; never prune the snapshot referenced by the current turn. Full-backup stewardship (when to create, verify, prune, restore) is §4.13.

### 4.5 Validate-before-reload/restart

Before any reload/restart/update:

1. `ha_get_config_check` must return `valid` (the reload path also validates automatically and refuses to reload on invalid config [D]).
2. `ha_get_config` core state must be `RUNNING`, and `recorder_state.migration_in_progress`/`migration_is_live` must be false [D].
3. No backup/restore job is in progress (`sup_job_status`/`sup_backup_list`); the UI's restart button becomes "Wait and restart" during backups [D].
4. For add-on option changes, `POST /addons/<slug>/options/validate` must pass, and the user is told changes apply on next start [D].
5. For templates, render the exact template with real states before saving it into YAML (`ha_render_template`).
6. For automations, prefer testing with `automation.trigger` (or the trace view) before declaring success; a valid config is not proof the automation does what the user wants. [A]

### 4.6 Data the agent must never read into context or print

- Values of `secrets.yaml` and any `!secret`-resolved value (references are fine). [D]
- `/data/options.json` of our own app (may contain model/API keys) and options of other apps via Supervisor, which can contain passwords [D].
- `.storage/*`, `*.db`, user tokens, the Supervisor token.
- Camera images/streams unless the user explicitly asks (privacy).
- Any knowledge/web request containing HA internals. Routine fetching bypasses LLM-backed web search and sends only public metadata (release tags, integration domains, PyPI package names); never entity names, config content, the user's URL/IP, or tokens (§7.8).

Redaction rule: tool outputs pass through a redactor that replaces values of keys matching `password|secret|token|api_key|psk|wifi_psk` with `<redacted>`; audit logs record key names only. [A]

### 4.7 Dangerous action catalogue and deny-lists

Never callable through `ha_call_service` by default:

- `homeassistant.restart`, `homeassistant.stop`, `homeassistant.reload_all` (restart is a dedicated tool; reload is `ha_reload`), `homeassistant.check_config` (dedicated tool). [D]
- `shell_command.*`, `python_script.*`, `pyscript.*`, `command_line.*` (arbitrary execution). [A]
- `hassio.*`, `persistent_notification.dismiss` fine but `hassio.host_reboot`/`host_shutdown` are X. [D]
- `recorder.purge` with `apply_filter: true` and no `keep_days` (can delete history unexpectedly) — allow only with explicit intent and confirm. [D]
- `notify.*` broadcast to groups when the user asked for one person — resolve the target with the user first. [A]

Require the target entity to exist and be available before calling; `ha_get_services` must confirm the action name exists. For entity-targeted actions, resolve targets via `extract_from_target` when area/device/label is used and show the resolved entity list in the approval plan. [U]/[A]

### 4.8 Rate limits and loop protection

| Limit | Value (default) |
|---|---|
| Mutating tool calls per minute | 10 |
| `ha_restart` per 10 minutes | 1 |
| Core update / full restore per hour | 1 |
| Backup creations per day | 3 |
| Notifications per target per hour | 3 (beyond that, aggregate) |
| Config write attempts on the same file per turn (after `STALE_BASE`) | 2, then stop and ask the user |
| Identical failing tool call (same params, same error) | 2 attempts, then report |

[A] Limits are enforced in the plugin with DSH loop-guard cooperation, not just prompt text.

### 4.9 Audit trail

Every mutating call appends one JSON line to `/data/audit/audit.jsonl`:

```json
{"ts":"2026-11-11T10:01:02+01:00","tool":"config_write","class":"SW","params":{"path":"configuration.yaml","sha":"…"},"result":"ok","snapshot_id":"20261111T100102","approval":null,"session":"…"}
```

DIS/DES calls additionally create a persistent notification naming the action and the actor ("DeepSeek Harness"), so a household member sees what changed even if they did not watch the chat. [A] The DSH session log remains the model-facing source of truth; the audit file is the human-facing, secret-free mirror.

### 4.10 Rollback

1. **Preferred:** `config_snapshot`/`config_restore` for every touched file; `config_write` auto-snapshots.
2. **Repo-aware:** if `/config/.git` exists, offer commit-per-change (`git -C /config add -A && commit -m "dsh: <intent>"`); do not initialize git in `/config` automatically. [A]
3. **HA-level:** Supervisor backup restore for wide damage — always last resort, destructive (§4.1).
4. After rollback: run `ha_get_config_check`, reload, and verify the previously broken entity/automation state. [A]

### 4.11 Explaining risk to a non-expert

Use a fixed four-part risk sentence (one short paragraph, not a wall):

> **What I'll do:** restart Home Assistant after adding the template sensor.
> **What you'll notice:** Home Assistant is unavailable for about a minute; lights keep working; automations that are mid-run stop.
> **Can we undo it:** yes — I saved a snapshot just now; I can restore it.
> **Why now:** the new sensor needs a restart the first time it is loaded. If you'd rather wait, I can prepare the YAML and you restart from **Settings → System** when convenient.

Rules: no unexplained jargon ("reload vs restart" gets one clause of explanation when it matters); never say "minor" about a restart; never hide a failed step — put the error in plain language plus the next safe action; state what was *not* touched when that is the reassuring part.

### 4.12 Add-on options that gate capabilities

Product semantics live here; the concrete `config.yaml` schema is owned by **`ha-addon.md` §8.1**. Shared options keep that document's names and safe defaults; additions are marked *new* and need the same enforcement. The add-on ships read-only and monitoring-only, and the user opts into capability. [A]

| Option | Type | Default | Effect | Owner |
|---|---|---|---|---|
| `read_only` | bool | `true` | Exposes only class R tools + monitor; no config writes, service calls, restarts or app management | ha-addon |
| `allow_restarts` | bool | `false` | Enables `ha_restart` and app restart/update tools | ha-addon |
| `allow_addon_management` | bool | `false` | Enables install/start/stop/options/rebuild (still DES-gated) | ha-addon |
| `monitor_enabled` | bool | `true` | Runs probe/digest scheduler | ha-addon |
| `notify_service` | string | empty | `notify.<entity>` name for phone notifications; empty = persistent notification only | ha-addon |
| `backup_retention` | int 1–90 | `7` | How many `dsh-weekly-*` backups to keep (§4.13) | ha-addon |
| `quiet_hours` | string `HH:MM-HH:MM` | `22:00-07:00` | Suppresses severity ≤2 notifications | ha-addon |
| `allow_service_calls` | enum `safe_only\|all\|none` | `safe_only` | *new*: `safe_only` allows non-safety domains; `all` allows safety domains with confirmation; `none` disables `ha_call_service` | proposed |
| `allow_addon_build` | bool | `false` | *new*: enables `addon_scaffold`/`addon_build` (writes `/addons`) | proposed |
| `allow_backup_restore` | bool | `false` | *new*: enables `sup_backup_restore`/`sup_core_update`; restore stays DES | proposed |
| `approval_mode` | enum `ask\|auto_safe\|auto_all` | `ask` | *new*: `auto_safe` auto-approves ≤ACT; `auto_all` is developer-only and never DES | proposed |
| `monitor_probe_minutes` | int 15–120 | `30` | *new*: cheap probe interval | proposed |
| `monitor_digest_time` | string `HH:MM` | `08:00` | *new*: daily digest in HA timezone (`/api/config.time_zone` [D]) | proposed |
| `knowledge_enabled` | bool | `true` | *new*: run the ecosystem watcher (§7); off = no outbound knowledge fetches | proposed |
| `knowledge_poll_hours` | int 2–24 | `6` | *new*: release-feed/GitHub poll cadence | proposed |
| `knowledge_digest_llm` | bool | `false` | *new*: allow the one-call synthesis for news digests | proposed |
| `backup_weekly_enabled` | bool | `true` | *new*: weekly full backup when no automatic backup exists | proposed |
| `config_workspace` | string | `/config` | *new*: allowed config root (matches the `homeassistant_config` mount in `ha-addon.md`) | proposed |

### 4.13 Backup stewardship policy

The agent owns backup hygiene: it creates backups at the right moments, verifies them, keeps the set bounded, and knows which backup precedes which change.

**Automatic creation triggers** (each verified, never fire-and-forget):

| Trigger | Action | Why |
|---|---|---|
| Before HA Core update | Use the Supervisor's own `backup: true` on `POST /core/update`; if unavailable, `sup_backup_create partial {homeassistant: true, name: "dsh-pre-core-<ts>"}` and wait for job success **before** updating [D] | An update cannot be undone by a restart, and DB migrations can fail |
| Before an app update that crosses a major version or hits `breaking_versions` | `sup_addon_update {backup: true}` [D] | App config/data migrations are the common failure |
| Before app uninstall with `remove_config: true` | `sup_backup_create partial {addons: [slug], name: "dsh-pre-uninstall-<slug>-<ts>"}` [D] | The app's public config folder is deleted [D] |
| Before restoring any backup | `sup_backup_create partial {homeassistant: true, name: "dsh-pre-restore-<ts>"}` | Restore overwrites the current state |
| Before a structural config change (new YAML integration, multiple files, `configuration.yaml` rewrite) | `config_snapshot` (file-level) is the minimum; a partial HA backup when the user agrees | Snapshots cover single files; a partial backup covers includes and the runtime state we never edit |
| Weekly (no automatic backup configured) | Full backup `dsh-weekly-<YYYYMMDD>` when the newest full backup is older than 7 days and disk free is at least 2× the last backup size; otherwise warn instead of filling the disk [D]/[A] | Unattended safety net without disk exhaustion |

**Naming:** `dsh-<reason>-<YYYYMMDD>-<HHMM>`, reason in `pre-core|pre-app-update|pre-uninstall|pre-restore|weekly|manual`. The ledger maps names to causes.

**Verification (all three must pass):** (1) the create/update job finishes with no errors (`sup_job_status`); (2) the backup appears in `sup_backup_list` with non-zero size and the expected content (`homeassistant`/`addons`/`folders`) [D]; (3) `sup_backup_info(slug)` reports date and, for encrypted backups, `protected: true` with no password stored by us [D]. Record `verified_at` in `/data/memory/backups.json`. A failed verification aborts the risky operation and notifies the user.

**Retention:** keep (a) the newest backup always; (b) all `dsh-*` backups from the last 30 days; (c) at most `backup_retention` (default 5) `dsh-weekly-*` backups. Prune only backups the agent created with the `dsh-` prefix, only via `DELETE /backups/<backup>` [D], only after a user-visible notice, and never touch user-created backups. Before deleting, confirm the ledger has at least one verified backup newer than the deletion candidate.

**Restore guidance:** smallest scope first — single file via `config_restore` → app restore → HA partial restore → full restore. Always state what will be overwritten, which versions are inside the backup (`sup_backup_info`), and that Core and apps restart during a restore [D]. Restore is DES: dry-run plan + token + explicit user confirmation. After restore: `memory_refresh(full)`, `record_change`, config check, re-check the entity/automation that motivated the restore, and note that monitor baselines reset.

**Disk safety:** before any backup, check `/host/info` disk free and require free space ≥ 2× the previous backup size (the recorder docs already require at least DB size free for DB operations; we add headroom) [D]. If there is not enough space, report instead of backing up.

**Monitoring link:** the `backups.fresh` signal (§5.1) and the digest report the newest verified backup age; `days_until_stale` comes from the Supervisor [D]. A backup that has never been restored is still unproven: the weekly digest may suggest (never automate) a restore test on a spare setup.

**Memory link:** the `backups.json` ledger and `changelog.jsonl` cross-reference backup slugs, so the agent can answer "what changed since backup X?" and "which backup should I restore?" (§6.8).

---

## 5. Monitoring design

### 5.1 Signals

| Check id | What | Source | Default thresholds | Severity |
|---|---|---|---|---|
| `core.reachable` | HA REST answers with `API running.` | `GET /api/` [D] | 2 consecutive misses | 4 |
| `core.state` | Core state; recorder migration flags | `GET /api/core/state` [D] | state ≠ `RUNNING`; migration in progress > 30 min | 2 / 3 |
| `entities.unavailable` | Count of `unavailable`/`unknown` entities, by platform/area | `GET /api/states` + registry [D]/[A] | > baseline + 3σ or > 10% and ≥ 5; 4 if > 25% and ≥ 10 | 1–4 |
| `entities.regression` | Newly unavailable entities vs 24 h baseline (set diff) | probe snapshots | ≥ 3 entities of one platform | 2 |
| `log.new_errors` | New normalized ERROR/WARNING signatures in the last window | `ha_get_error_log` [D] / system log [U] | any new signature; escalate on `failed to set up`, `Error setting up`, `database is locked`, `No space left`, `out of memory` | 2–4 |
| `repairs.open` | Open repair issues | `ha_get_repairs` [U] | any new; deprecated/pwned issue types → 3 | 2–3 |
| `resolution` | Supervisor unhealthy/unsupported reasons and issues | `GET /resolution/info` [D] | any unhealthy reason → 3; unsupported → 2 | 2–3 |
| `automations.stale` | Enabled automations with no `last_triggered`, or no trigger in N days while expected | `ha_list_automations` [A] | never triggered and created > 7 days; expected-daily with none in 3 days (heuristic) | 1–2 |
| `automations.failing` | Recent runs that ended in error / "Stopped on error" | traces [U] | any in window | 2 |
| `recorder.db` | `home-assistant_v2.db` size and growth; free temp space | `config_list` on `/home-assistant_v2.db` + `/host/info` disk [D] | DB > 2 GiB or +200 MiB/day; free space < 2× DB or < 15% disk | 2–3 |
| `disk` | Host data disk free | `GET /host/info` `disk_free`/`disk_total` [D] | < 15% or < 5 GiB → 2; < 5% or < 1 GiB → 4 | 2–4 |
| `memory` | Core/Supervisor/app memory usage | `GET /core/stats`, `/addons/<slug>/stats` [D] | core memory_percent > 85% for 3 probes | 2 |
| `backups.fresh` | Newest backup age, automatic backup failure state | `GET /backups/info` `days_until_stale` [D]; backup sensors [D] | age > configured interval × 2 or > `days_until_stale` → 2; > 7 days → 3; last attempt failed → 3 | 2–3 |
| `updates` | Available core/supervisor/os/app updates | `GET /available_updates` [D] | available > 14 days → 1; security release → 2 | 1–2 |
| `apps.health` | App state `error`, unexpected `stopped` with `boot: auto`, watchdog off for ingress-exposed apps, restart count | `GET /addons` [D] | error → 3; stopped with boot auto → 3 | 2–3 |
| `restart_loop` | ≥ 3 HA starts in 1 h, or core unreachable ≥ 2 probes | `homeassistant_start`/logbook events (WS) [A]; probe misses | threshold hit | 4 |
| `network` | Host/supervisor internet | `GET /network/info` [D] | host_internet false > 6 h | 2 |
| `time` | Host clock sync | `/host/info` `dt_synchronized` [D] | false | 2 |
| `knowledge.stale` | Knowledge source older than 2× its cadence, or offline > 24 h | `/data/knowledge/state.json` | one stale source → 1; all stale/offline → 2 |
| `compat.upcoming` | Breaking/deprecation findings for an available update | `ha_compat_scan` (§7.6) | breaking → 3; deprecation → 2 |
| `self.health` | Our ingest/UI reachable, scheduler last tick age | internal | last tick > 3× interval | 2 (local only) |

Every threshold is a starting point to be tuned; the agent must treat heuristic checks (`automations.stale`, some log signatures) as lower confidence and phrase them as questions, not verdicts. [A]

### 5.2 Severity and scoring

Severity: `0 ok`, `1 info`, `2 warning`, `3 serious`, `4 critical`. Confidence: `high` (direct documented value), `medium` (derived comparison), `low` (heuristic). Attention score for sorting the digest: `severity * 10 + min(affected_entities, 20) + confidence_bonus`. The daily digest sorts by score and shows at most 5 "needs attention" entries. Immediate notification only for severity ≥3 that is new or escalated. [A]

### 5.3 State, dedup, and quiet hours

Persist to `/data/monitor/`:

- `state.json` — `version`, `baselines` (unavailable count by platform, log signature counts, DB size, disk free), `last_probe`, `last_deep_probe`, `last_digest`, `cooldowns` (`key → last_fired`), `probe_ring` (last 288 cheap probes, ~6 days at 30 min).
- `findings.jsonl` — append-only findings with `{ts, check, severity, key, message, evidence_refs[]}` (evidence refs are pointers to tool calls/session ids, not secrets).
- `config.json` — user's monitor settings from §4.12.

Dedup key: `check + ":" + normalized_signature` (normalize timestamps, entity counts, UUIDs, numbers in log messages). Same key does not notify again for 6 h unless severity rises by ≥1. [A]

Quiet hours (`quiet_hours`, default 22:00–07:00 in HA timezone): severity ≤2 held until the digest; severity 3 held until 07:00 unless it persists >4 h; severity 4 notifies immediately. [A]

### 5.4 Immediate notification vs digest

- **Immediate** (`notify_user`): severity 4; new severity-3 with clear user impact (core down, backup failed repeatedly, app crash loop, disk nearly full).
- **Digest only:** everything else. The digest is the default channel — monitoring that pings every 30 minutes gets muted.
- A user-facing "all good" digest is worth sending when an alert was sent in the previous 24 h (closes the loop); otherwise the digest can be skipped on all-clear days, or sent weekly. [A]

### 5.5 Digest format (≤20 lines, Markdown)

```
🟠 Home Assistant — daily check, Tue 11 Nov

Status: 2 things need attention, 1 improved.
Since yesterday: 3 entities came back (hue), 1 new error signature.

Needs attention:
1. [serious] kitchen_motion is unavailable since 03:12 — battery? (last changed 41 h ago)
2. [warning] Disk 12% free (was 18%) — recorder DB is 3.1 GB; purge keeps 10 days.

Quiet: no new repairs; latest backup 4 h ago (full, 2.1 GB); core 2026.11.1 is current.

Details: Settings → System → Logs; ask me to "dig into #1".
```

Rules: plain language, user names; one line per finding; every finding is linked to the actionable next step (not "check logs"); no raw JSON; never include secrets/tokens/URLs with tokens. The digest message is also written to `findings.jsonl` with `kind: digest` for later "what did you tell me yesterday" questions. [A]

### 5.6 Schedule and persistence

| Job | When | Cost | Output |
|---|---|---|---|
| Cheap probe | every `monitor_probe_minutes` (30) | 4–6 HTTP calls, <2 s | findings, cooldown updates, no LLM needed |
| Deep probe | every 6 h and after any severity ≥3 probe | + logs, repairs, resolution, addons | findings |
| Daily digest | `monitor_digest_time` in HA timezone | probe data + one LLM call only if findings exist | notification + findings record |
| Weekly summary | Monday digest | aggregated trends | notification |
| Knowledge poll | every `knowledge_poll_hours` (6) | conditional GETs, parse, index — 0 LLM | `/data/knowledge` state + index, "what's new" digest |
| Compatibility scan | whenever an update is available, and weekly | 0 LLM | findings for the update plan and monitor state |
| Self-check | each probe | scheduler tick age | local warning only |

The scheduler belongs to the host plugin, not to a chat session: monitoring must continue when no conversation is open. The optional LLM narrative for the digest runs in a short dedicated session with the monitor skill loaded; if the model call fails, the deterministic template digest is still sent. [A] Persist `last_digest` so restarts of our app do not resend the digest.

### 5.7 What monitoring must not do

- No autonomous config changes or restarts from a probe. [A]
- No writing to HA beyond notifications (persistent notifications are the only HA-visible output of probing). [A]
- No reporting a count without its baseline ("23 entities unavailable" is meaningless without yesterday's number). [A]
- No notification storms: aggregate per digest window when >3 findings of severity ≤2. [A]

---

## 6. Agent memory and system state

### 6.1 Why this exists

Home Assistant users talk to the agent in short bursts, days apart. Without memory the agent re-asks the same questions, re-diagnoses the same quirks, and cannot say "I changed that last Tuesday, and you have a backup from before it". Memory also cuts tool calls and tokens: most "what do I have?" questions are answered from the last collected snapshot, and the agent refreshes only what changed.

### 6.2 Storage under `/data`

```
/data/memory/
├── system.json        # structured memory: schema_version, revision, collected{}, curated{}, updated_at
├── system.md          # human-readable rendering of curated notes (+ collection summary), safe to show the user
├── changelog.jsonl    # append-only: one line per durable change or learned fact
├── backups.json       # backup ledger: created/verified/restored/pruned events (§4.13)
└── baselines.json     # monitor baselines and cooldown state (owned by §5)
```

`/data` is the app's private persistent folder: always mounted read-write, survives app restarts and app updates, and is part of the app's own backup unless excluded [D]. When `app_config` is mapped, mirror `system.md` (never secrets, never raw `system.json` internals) to the user-visible `app_configs/<slug>/memory/system.md` so the user can read and back it up; the canonical copy stays in `/data`. [A]

### 6.3 Two ownership domains

| Domain | Written by | Contents | Rule |
|---|---|---|---|
| `collected` | deterministic code only (no LLM) | facts fetched from HA/Supervisor, with timestamps | never edited by `memory_update`; refreshed by `memory_refresh`; replaced when live data disagrees |
| `curated` | agent via `memory_update`, user via chat or by editing `system.md` | interpretation, preferences, quirks, intent, history | capped and revisioned; never written by collection code, never overwrites `collected` |

### 6.4 Deterministically collected inventory (no LLM)

| Field | Source | Refresh |
|---|---|---|
| `versions` | `/api/config.version`, `/core/info`, `/os/info`, `/supervisor/info` [D] | app start, daily, after updates |
| `host` | `/host/info` (machine, arch, disk_free/total/used, os) [D] | app start, daily |
| `system` | `/info` (arch, supported_arch, channel, healthy) [D] | app start, daily |
| `integrations` | `/api/config.components` [D] | daily, after app/HA update |
| `entities` | `/api/states` counts by domain; registry platform counts [D]/[A] | daily |
| `areas_devices` | registry lists [U] | daily |
| `automations` | `ha_list_automations` (entity_id, alias, state, last_triggered, id) | daily, after config changes |
| `apps` | `/addons` (slug, name, version, state, update_available, boot, watchdog; option **names** only) [D] | daily, after app changes |
| `updates` | `/available_updates` [D] | daily |
| `backups` | `/backups/info` summary + ledger `backups.json` [D] | after every backup operation, daily |
| `config_files` | `config_list` inventory with sha256/mtime/size; `secrets.yaml` hash only, never content [D]/[A] | after config writes, daily |
| `notify_targets` | `notify.*` entities/actions from states + `ha_get_services` [D] | daily |
| `monitor` | effective monitor settings and last digest [A] | on change |

Collection is idempotent, bounded (one request per section, lists truncated with counts in the snapshot), and runs without any model call. Target size: `system.json` < 128 KB.

### 6.5 Curated memory (the part that feels like a colleague)

| Bucket | Example | How it changes |
|---|---|---|
| `preferences` | "Call the room 'living room', not 'lounge'"; "notify me on my phone, never announce"; "plan first, then act"; quiet hours | user states it; agent confirms once |
| `hardware` | "Zigbee coordinator is on `/dev/ttyUSB1` and needs a USB extension"; "heater has a 2-hour manual override" | setup facts, replaced hardware, incidents |
| `quirks` | "Kitchen motion sensor drops for ~2 min when the microwave runs"; "EV charger reports unavailable during firmware updates" | diagnosis; resolved when confirmed gone |
| `incidents` | short summaries of past problems and what fixed them, linked to `changelog.jsonl` entries | when a diagnosis closes |
| `intent` | "`automation.porch_lights` exists to light the porch 30 min before sunset" | when creating/editing automations |
| `do_not_touch` | entities/automations the user asked us to leave alone, and why | user instruction |
| `open_tasks` | "waiting for the new Zigbee bulb before adding the automation" | agent task tracking |
| `backup_policy` | user overrides (weekly on/off, retention, target location) | user decision |

### 6.6 Schema sketch

```jsonc
{
  "schema_version": 1,
  "revision": 42,
  "updated_at": "2026-11-11T10:04:00+01:00",
  "collected": {
    "collected_at": "2026-11-11T09:59:00+01:00",
    "versions": { "ha": "2026.11.1", "supervisor": "2026.11.0", "os": "18.3" },
    "host": { "machine": "generic-x86-64", "arch": "amd64", "disk_free_gib": 41.2, "disk_total_gib": 128.0 },
    "integrations": { "count": 37, "custom_count": 2 },
    "entities": { "total": 412, "by_domain": { "light": 38, "sensor": 201 }, "unavailable": 3 },
    "automations": [ { "entity_id": "automation.porch_lights", "alias": "Porch lights", "state": "on", "last_triggered": "2026-11-10T17:12:00+01:00" } ],
    "apps": [ { "slug": "core_mosquitto", "version": "6.5.1", "state": "started", "option_keys": ["logins"] } ],
    "backups": { "count": 6, "newest": "2026-11-10T03:00:00+01:00", "days_until_stale": 30 },
    "config_files": [ { "path": "configuration.yaml", "sha256": "…", "bytes": 4213 } ]
  },
  "curated": {
    "preferences": [ "Phone notifications only, no TTS." ],
    "hardware": [ "Zigbee coordinator: /dev/ttyUSB1 (USB extension required)." ],
    "quirks": [ { "id": "q_kitchen_motion", "text": "…", "added": "2026-11-01", "resolved": null } ],
    "intent": { "automation.porch_lights": "Light the porch 30 min before sunset when someone is home." },
    "do_not_touch": [ { "target": "automation.alarm", "why": "user manages it from the alarm panel" } ],
    "open_tasks": [],
    "backup_policy": { "weekly": true, "retention": 5 }
  }
}
```

### 6.7 Update policy

- **Refresh triggers:** app start; first probe of the day; after an HA restart (version/state change or `homeassistant_start` event [U]); after every mutating tool call; immediately before any DIS/DES plan, so the plan quotes real versions and backups.
- **Curate triggers:** after a successful change (`record_change`: what, why, tool, snapshot/backup id); after a diagnosis that discovered a durable quirk; when the user states a preference or a "don't touch"; when a recorded quirk is verified gone (`resolve_quirk`).
- **Conflict rule:** collected data beats curated on facts; a refresh never silently overwrites curated notes; when a curated fact contradicts collected data, the refresh wins and the stale note is marked `verify`.
- **Bounds:** curated ≤ 32 KB and ≤ 200 entries total; `changelog.jsonl` rotates at 2 MB (keep 5000 lines); never store secrets, tokens, passwords, full state dumps, or personal data the user did not volunteer.
- **Never stored:** `secrets.yaml` values, app option values, tokens, camera snapshots, full attribute dumps.

### 6.8 Survival across updates and restores

- `/data` persists across app restarts and app updates, so memory survives our own upgrades. [D]
- App data (including `/data/memory`) is included in the app's backup on a full HA backup unless excluded by `backup_exclude`; never exclude `memory/`. [D]
- After a full restore, memory may describe a system newer than the restored state. First action after restore: `memory_refresh(full)` plus a `record_change` entry ("restored backup `<slug>` at `<time>`"). [A]
- Uninstalling our app with data removal deletes memory. Before such an action the agent offers to export `system.md`/`system.json` into the user-visible `app_config` mirror or a downloadable artifact. [A]
- The backup ledger (`backups.json`) lets the agent answer "which backup was taken before the change that broke this?" without guessing. [A]

### 6.9 Freshness contract for skills

Skills call `memory_get` early. Rules: (1) never answer a live-state question from memory alone — memory supplies context, tools supply facts; (2) if `stale[]` contains a needed section, refresh it; (3) when memory and live state disagree, the tool result wins and the skill records the correction; (4) the user can ask "what do you remember about my house?" and get a plain-language summary from `system.md`.

---

## 7. Ecosystem watcher, local knowledge, compatibility and recommendations

### 7.1 Purpose and principles

The agent should anticipate, not just react: know what changed in Home Assistant before the user hits it, warn before an update, and recommend functionality that fits the house. Five principles govern the whole section:

- **Local-first, cache-first.** Fetching, parsing, indexing, dedupe and matching run inside the add-on with plain conditional HTTP and a local SQLite index. That path makes **zero LLM calls**.
- **Synthesise on demand.** The model touches knowledge only when the user asks or a digest is due, and reads short retrieved excerpts — never whole pages.
- **Public metadata only.** Only public URLs and public inventory are fetched. HA internals never leave the house (§7.8).
- **Evidence over vibes.** Every claim carries a source URL and a fetch date. Stale data is labelled stale, never presented as current.
- **Bounded and degradable.** Byte/item/time caps, per-source backoff, and a cache-only mode when offline or rate-limited.

### 7.2 Sources and cadence

| Source id | URL / surface | What we take | Cadence | Conditional |
|---|---|---|---|---|
| `ha.blog` | HA blog feed (`https://www.home-assistant.io/blog/feed.xml`) [A: confirm feed URL] | release posts, announcements | 6 h | ETag/Last-Modified |
| `ha.release_notes` | release-notes page linked from each post (`/latest-release-notes/` → `blog/YYYY/MM/DD/release-YYYYMM/`) [D] | version, "Breaking changes"/"Backward-incompatible changes" sections, new integrations, deprecations | on new post + daily | ETag |
| `gh.core.releases` | `api.github.com/repos/home-assistant/core/releases?per_page=5` [A: GitHub REST] | tags, dates, release body | 6 h | ETag |
| `gh.frontend.releases`, `gh.supervisor.releases` | same for `home-assistant/frontend` and `home-assistant/supervisor` [A] | versions, notes | 6 h | ETag |
| `gh.components` | `api.github.com/repos/home-assistant/core/contents/homeassistant/components?ref=<tag>` [A] | new/removed integration domains as a set diff between releases | per new Core release | one call, ETag |
| `gh.manifest.<domain>` | `raw.githubusercontent.com/home-assistant/core/<tag>/homeassistant/components/<domain>/manifest.json` [A] | requirements (PyPI packages + pins), integration type, quality scale, version | daily for installed domains only | ETag |
| `pypi.<package>` | `https://pypi.org/pypi/<package>/json` [A] | latest version + release dates for installed requirements | weekly, installed domains only, ≤100 packages | skip when version unchanged |
| `store` | Supervisor `GET /store`, `/store/addons/<slug>`, `GET /addons` [D] | apps, versions, descriptions, ratings, categories | at scan/recommend time (local) | none needed |
| `gh.repo.<owner/name>` | `api.github.com/repos/...` [A] | stars, last release, archived flag for shortlisted recommendations only | on demand | ETag; search API ≤10 req/min |
| `hacs.default` | HACS default lists in `github.com/hacs/default` (`integration`, `plugin`, …) [A: confirm paths] | community integration/app inventory | daily | ETag |
| `gh.topics` | GitHub search for `home-assistant` / `hacs-integration` topics [A] | discovery hints, on demand only | on demand | rate-limited + cached |
| `ha.integration_docs` | `home-assistant.io/integrations/<domain>/` [A] | doc excerpts used in recommendations | on demand, cached 30 days | ETag |

Rules: at most two requests in flight; exponential backoff on 403/429/5xx (1 min → 1 h); unauthenticated GitHub allows 60 requests/hour and 10 search requests/minute, so batch and cache aggressively; never fetch on page load; every source has its own `next_due` and cursor. The Supervisor's own `/available_updates` is the cheapest update source and is checked before any GitHub call. [D]

### 7.3 Storage and index under `/data/knowledge`

```
/data/knowledge/
├── state.json            # per-source: etag, last_modified, last_checked, last_success, last_change, error, next_due, cursor
├── raw/<source>/         # fetched bodies, content-addressed by sha256, pruned by age
├── index.sqlite          # FTS5 index: documents, chunks, rules, seen, meta
├── releases.json         # normalized release records per product (version, date, url, section anchors)
├── catalog/store.json    # last store/integration snapshot used for recommendations
├── digests/YYYY-MM-DD.md # deterministic "what's new" digests
└── compat/known.json     # extracted breaking-change/deprecation rules with source URLs
```

SQLite FTS5 through `node:sqlite` `DatabaseSync` — the same built-in module DSH already uses for `storage-sqlite` and `session-query-sqlite`, so no new native dependency. [D for node:sqlite in this codebase/Node 24; A for FTS5 availability — check `sqlite_compileoption_used('ENABLE_FTS5')` at startup and fall back to JSONL + BM25 if absent.]

Schema: `documents(id, source, url, title, published_at, fetched_at, lang, hash, kind)`, `chunks(doc_id, seq, section, text)`, `rules(id, source_url, kind, severity, version_from, version_to, domains, keywords, text)`, `seen(item_id, first_seen, last_seen, digest_id)`, `meta(key, value)`. Dedupe by canonical URL + content hash; `seen` stops repeated digest items. Caps: raw ≤ 200 MB, index ≤ 100 MB; prune raw older than 90 days (keep release notes and rules indefinitely); vacuum monthly. All writes transactional; the index is rebuildable from `raw/`.

Fallback: if FTS5 is unavailable or the environment forbids `node:sqlite`, write `chunks.jsonl` and run a small in-process BM25 at query time; k is capped, so memory stays bounded.

### 7.4 Deterministic pipeline

1. **Fetch** with conditional headers; `304 Not Modified` only updates `last_checked`.
2. **Parse** with a per-source adapter: RSS/Atom (XML), GitHub JSON (releases/contents/trees), PyPI JSON, Markdown/HTML release notes (heading-anchored section extraction). Extractors carry an `extractor_version`; a parse break marks the document `partial` and can force reindex.
3. **Normalize** into release records, rule records and document/chunk rows. No LLM: domains, headings, YAML keys and action names are extracted with rules and word lists.
4. **Index** in one transaction and update `seen`.
5. **Digest** from a template: new releases, extracted breaking-change headings, new integrations, rules affecting installed integrations, and store changes in categories the user has shown interest in. ≤15 lines, no model call.
6. **Compatibility scan** matches `rules` against the installed inventory and YAML usage (§7.6).
7. **Recommendation** does retrieval + scoring; at most one model call for phrasing (§7.7).

### 7.5 Token and cost policy

| Path | LLM calls |
|---|---|
| fetch / parse / index / dedupe | 0 |
| "what's new" digest | 0 (template); optional 1/day synthesis only if the user asks for a narrative |
| compatibility scan | 0 |
| knowledge question that an excerpt answers | 0 extra after `knowledge_search` |
| recommendation | 1 call maximum, after local retrieval, to structure the need and phrase the options |
| chat answer citing knowledge | use cached excerpts; never paste full pages |

Budgets: by default ≤1 synthesis call/day and ≤200 fetches/day; when exceeded, pause non-essential sources and say so in the digest. Metrics logged to `/data/knowledge/metrics.jsonl`: fetches, 304 ratio, bytes, index size, LLM calls, digest latency. `knowledge_search` returns ≤600-character excerpts; answers cite `url` + `fetched_at` ("as of 10 Nov 2026").

### 7.6 Compatibility scanner (`ha_compat_scan`)

**Inputs:** installed integrations (`/api/config.components` [D]), custom components (`/config/custom_components/*/manifest.json` — read manifests only, never `.storage`), YAML feature usage via `config_search` (domains, keys, action names, template functions), and update targets from `sup_get_updates` [D].

**Matching:** `rules.domains`/`keywords` against integration domains, integration names, YAML keys, action names and template functions.

**Output per finding:** `severity` (`breaking|deprecation|warning|info`), `target`, `affected` count + a few samples (entities/automations/apps), evidence quote + source URL, `remediation`, `confidence`, `applies_to` version range.

**Severity mapping:** `breaking` — the update fails or the feature is removed in it; `deprecation` — works now, removal announced; `warning` — behavior change; `info` — new option/feature. A custom integration without support for the target HA version is `breaking` with medium confidence (manifest-based).

**Triggering:** the monitor job runs `ha_compat_scan {upcoming: true}` whenever `/available_updates` shows a Core/OS/app update, and the update playbooks run it before `sup_core_update`/`sup_addon_update`. Findings are advisory unless `breaking`; then the update plan must show them and ask for explicit acknowledgement — the user still decides. Never silently block an update and never auto-edit YAML to dodge a deprecation.

**Presentation:** at most five findings, one line each plus one evidence link, with the affected count and the release version it lands in.

### 7.7 Recommendation assistant (`ha_recommend`)

**Inputs:** the need, constraints (no cloud, no new app, effort, hardware, budget), optional category.

**Retrieval:** `knowledge_search` over release notes and integration docs + the store catalog snapshot + installed inventory.

**Candidate classes, best first:** native integration → official app → community app/HACS → external service or manual approach.

**Score (0–5 each, shown to the user):** *fit* (capability match, exact vs partial, works with their hardware and HA version); *effort* (install + configuration steps, native integration lowest); *risk* (permissions/security rating for apps, cloud dependency, unofficial or abandoned projects, breaking-change history); *maintenance* (last release age, archived flag, core vs HACS, open-issue signal fetched only for the shortlist).

**Presentation:** 2–3 options in a compact tradeoff table, "what I would pick and why", prerequisites, and what changes on their system. Cite sources with dates, label HACS/community support explicitly, and never install during a recommendation — installation is a separate, confirmed playbook in the app-builder skill. If the cache is stale or offline, say "knowledge is from <date>; want me to refresh?".

### 7.8 Privacy and safety boundaries

- Only public metadata leaves the house: release tags, public docs, integration domains, PyPI package names, store listings.
- Never entity names, automations, configuration, the user's URL/IP, installation identifiers, or tokens.
- Queries are generic (`hue`, `pyscript`), never "the user's kitchen sensor".
- Routine knowledge fetching **does not use LLM-backed web search**; the plugin fetches known URLs directly (`web_fetch` is a plain HTTP provider, while `web_search` is provider-backed and not free — see the DSH research in `dsh-container.md`).
- If the user explicitly asks to search the web for an integration or app, send only the integration/app name, treat all results as untrusted data, and never feed HA internals into the query.
- Knowledge answers are informational: installing, updating and changing YAML still follow §4 (approval, backup, verify).
- Cache honesty: never present a cached release note as current; always attach `fetched_at` and the source URL. Store only what is needed, keep excerpts short, link to the source.

### 7.9 Failure modes and degradation

| Failure | Behavior |
|---|---|
| Offline / DNS blocked | serve cached knowledge, mark `stale_since`, skip network digests |
| GitHub 403/429 | exponential backoff per source; stop after 3 failures in an hour; retry next cadence |
| RSS/HTML structure changed | store raw body, mark `partial`, keep last good rules; log, do not chat-alert |
| FTS5 unavailable | JSONL + in-process BM25 fallback |
| Index corrupt | rebuild from `raw/`; re-fetch what was pruned |
| Rule false positive | severity `info`, low confidence, always with source; never auto-disable anything |
| Storage full | prune raw first, then old chunks; keep rules and releases; notify once |
| Clock skew | use published + fetched times; never claim "today" without both |

### 7.10 Tools and schedule

Tools: `ha_news_scan`, `ha_news_digest`, `knowledge_search`, `ha_compat_scan`, `ha_recommend` (§3.8). Schedule: knowledge poll every `knowledge_poll_hours` (6 h); compatibility scan whenever updates are available plus weekly; "what's new" digest weekly with the monitor digest or on request; full reindex monthly. All scheduling belongs to the plugin host, not to a chat session, and all steps except optional digest/recommendation phrasing are deterministic.

---

## 8. Add-on builder workflow

### 8.1 Requirements form (ask only what changes the scaffold)

1. **Name and purpose** — human name, one-sentence purpose, optional long description.
2. **Type** — web UI (ingress vs host port), background service, MQTT bridge, API poller.
3. **Data source** — HTTP API (URL, auth type), device/serial (`/dev/ttyUSB0`, USB, GPIO), MQTT, local files, nothing.
4. **Home Assistant integration** — needs HA API (`homeassistant_api: true`), needs Supervisor API (`hassio_api: true` + role `default`/`manager` only if it truly manages apps), sends discovery messages, exposes entities via MQTT discovery.
5. **Hardware capabilities** — `uart`, `usb`, `gpio`, `audio`, `video`, `devices`; warn that each lowers the security rating and requires the matching UI permission. [D]
6. **Options and secrets** — settings with types per §8.3; secrets are `password` schema options (users can also `!secret` reference HA secrets) [D].
7. **Persistence** — files under `/data` (private, backed up, survives updates) vs `app_config` (user-editable, in `app_configs`) [D].
8. **Architectures** — default `aarch64` + `amd64`; add others only if the user needs them (deprecated `armhf`/`armv7`/`i386` still accepted with warnings) [D].
9. **Version/new or update** — new folder or existing local app to extend.

Do not start scaffolding until the answers cover 1–3 and 7; everything else has a safe default and should be shown to the user as chosen defaults. [A]

### 8.2 Scaffold file set

```
/addons/<slug>/
├── config.yaml          # required: name, version (quoted string), slug, description, arch, init: false
├── Dockerfile           # FROM ghcr.io/home-assistant/base:3.24 ...
├── run.sh               # LF line endings, #!/command/with-contenv bashio
├── README.md            # repository-facing
├── DOCS.md              # app documentation tab
├── CHANGELOG.md         # app changelog tab
├── translations/en.yaml # option labels (configuration: ...)
├── icon.png             # optional 128x128, PNG
├── logo.png             # optional
└── apparmor.txt         # optional, only when a profile is needed
```

Rules and evidence: app folder with these three core files is the documented tutorial path [D]; `init: false` is required for the Home Assistant base image because S6 overlay is its init [D]; `run.sh` must use LF, and CRLF fails with an error that does not mention line endings [D]; options are documented in `options` + `schema` and delivered in `/data/options.json` [D]; `translations/en.yaml` uses the `configuration:` key tree [D]; `DOCS.md`/`CHANGELOG.md`/icons are served by the store API and documented as app files [D]. Do **not** generate `build.yaml` (deprecated) or `snapshot*` keys (deprecated) [D].

### 8.3 `config.yaml` lint rules (what `addon_validate` enforces)

| Rule | Detail | Evidence |
|---|---|---|
| Required keys | `name`, `version` (quoted string — YAML would read `1.10` as a number), `slug`, `description`, `arch` | [D] |
| Slug | letters, digits, `-`, `_`, `.`; unique in the repository; folder name should match | [D] |
| Arch values | only `aarch64`, `amd64` (plus deprecated names with warning) | [D] |
| `init` | `false` when the image has its own init (all HA base images) | [D] |
| `image` | absent for local builds; present only for published images; tag is always `version` | [D] |
| `ports` | `"container/protocol": host` with `tcp`/`udp`; host `null` = off by default | [D] |
| `ingress` | `ingress: true` needs a web server on `ingress_port` (default 8099); must not expose 62000–65500 in `ports` when `ingress_port: 0`; no host port needed for ingress | [D] |
| Options/schema parity | every `schema` key has a valid type; required options have defaults or the user cannot start; `password` for secrets; `list(a\|b)` for enums; `str?` optional convention (`?` suffix) | [D] |
| `map` | only valid types (`homeassistant_config`, `app_config`, `local_apps`, `share`, `ssl`, `media`, `backup`, `data`, `all_app_configs`); `read_only` defaults true; `path` not empty/`/` and unique | [D] |
| Privileges | warn and require explicit user consent for `privileged`, `full_access`, `host_network`, `host_pid`, `docker_api`, `apparmor: false`; each lowers the security rating (1–8, higher is safer) | [D] |
| `startup`/`boot` | `startup` in `initialize\|system\|services\|application\|once`; `boot` in `auto\|manual\|manual_only` | [D] |
| `backup` policy | `hot`/`cold`, optional `backup_pre`/`backup_post`, `backup_exclude` globs; `cold` ignores pre/post | [D] |
| Unknown keys | the Supervisor ignores unknown keys without a warning — the lint must reject typos explicitly | [D] |
| Filenames | `config.yaml`/`config.yml`/`config.json`; never reuse `config.yaml` for something else (the Supervisor scans the repository at any depth except `rootfs`/hidden folders) | [D] |
| Line endings | `run.sh` and any shell script must be LF | [D] |
| `webui`/`watchdog` | valid URL templates with `[HOST]`, `[PORT:nnnn]`, `[PROTO:option]` | [D] |

### 8.4 Dockerfile patterns

- Start from `ghcr.io/home-assistant/base:<tag>` (tutorial uses `3.24`) so bashio and S6 are present; install Alpine packages with `apk add --no-cache`. [D]
- Copy the entrypoint and make it executable: `COPY run.sh /` + `RUN chmod a+x /run.sh`; `CMD [ "/run.sh" ]`. [D]
- Entrypoint script starts with `#!/command/with-contenv bashio`; `with-contenv` is what gives access to the Supervisor token env. [D]
- Use `/data` for persistence and `WORKDIR /data` when serving files; `/data` is always read-write and private. [D]
- Use `app_config` when the user must edit files; it is mounted at `/config` inside the app and appears under `app_configs/<slug>` for the user. [D]
- Multi-stage builds are fine; cross-architecture builds need `--platform linux/arm64` / `linux/amd64` and QEMU in CI. [D]
- Never bake secrets or API tokens into the image; they belong in options or `!secret` references. [A]
- Local development testing uses the Supervisor build loop (rebuild after each change), because our app has no Docker socket. Plain `docker buildx build` and the devcontainer workflow are documented for humans but are not available to the in-cluster agent. [D]/[A]

### 8.5 Build / install / log-fix loop

1. `addon_validate(slug)` — fix all errors before touching the Supervisor; warnings need user acknowledgement when they involve privileges.
2. `sup_get_info(sections=["system"])` — confirm arch/machine match the app's `arch` list and there is disk space.
3. `sup_store_reload` — reads `local_apps` and the repositories, so the new folder shows up under **Local apps**. [D]
4. If the app already exists: bump `version` in `config.yaml`, then `sup_addon_rebuild(slug, force=true)` (equivalent to `ha apps rebuild --force local_my_app`). [D]
5. If new: `sup_addon_install(store_slug="local_<slug>", background=true)` → `sup_job_status` until done. The Supervisor builds the image, which takes a moment. [D]
6. Start it (`sup_addon_start`) and read the **Log** tab equivalent via `sup_addon_logs`. [D]
7. On failure, route by symptom:
   - App missing from **Local apps** → invalid `config.yaml`; read `sup_get_logs(target="supervisor")` for the parse error, fix YAML. [D]
   - Build fails → Supervisor log has the Docker build output; fix `Dockerfile`/dependency.
   - Starts then exits → app log tail; check `run.sh` LF, `init`, missing env, crash on missing option. [D]
   - Starts but function broken → check network/ports/ingress and the app's own HTTP endpoint; check `homeassistant_api`/`hassio_api` settings.
   - Update not offered → `version` was not raised, or `image:` still present for a local app. [D]
8. After success: verify externally (open ingress path / query the entity the app creates), then present the result (§8.6).

### 8.6 Presenting the result to the user

- **What was built:** name, purpose, where the code lives (`/addons/<slug>`), version.
- **How to use it:** exact UI path — **Settings → Apps → Install app / App store → Check for updates → Local apps → `<name>` → Install → Start**, then the ingress entry in the sidebar or `http://<ha-host>:<port>`. [D]
- **How to change it:** "edit files in `local_apps/<slug>`, then Check for updates → Rebuild; raise `version` for normal updates." [D]
- **Logs:** app **Log** tab, plus Supervisor logs for store/config errors. [D]
- **Files to read:** `DOCS.md` (users), `CHANGELOG.md` (versions), `README.md` (repository), `translations/en.yaml` (option labels).
- **Backup/removal:** local apps are part of the `addons/local` backup folder in a full backup [D]; uninstalling with data removal deletes the app's config folder [D].
- **Publish path (only if asked):** push to a GitHub repository with the app in a folder, add the repository URL via the store, publish images to a registry for the architectures. [D]

### 8.7 Builder guardrails

- No `privileged`, `full_access`, `host_network`, `host_pid`, `docker_api`, or `apparmor: disable` unless the user explicitly accepts the security trade-off; explain what each grants. [D]
- No secrets in files, image layers, logs, or `README.md`; options with `password` type only. [A]
- No host filesystem access through `devices` beyond what the user asked for. [A]
- One app per user request; do not silently create repositories or extra apps.
- If the requested app is a thin wrapper around an existing official app or integration, say so and recommend that instead (principle 2). [A]

---

## 9. Known pitfalls catalogue

This feeds the skills; each row is something the agent should recognize before or during an action.

| # | Pitfall | Symptom | Correct behavior |
|---|---|---|---|
| 1 | YAML tabs / bad indentation | `Error loading /config/configuration.yaml: …` or config check invalid | Never emit tabs; 2-space indent; read the file and mirror its existing indentation style; run config check after writes [D] |
| 2 | Old + new automation keys mixed | Editor silently drops old-key blocks, or setup fails `Cannot specify both 'trigger' and 'triggers'` | Emit `triggers:`/`conditions:`/`actions:` with singular item keys; never both forms; mention the rename when fixing user YAML [D] |
| 3 | `!include`/`!secret`/packages semantics | Edit lands in the wrong file or is ignored | Follow includes to the actual source file before writing; include paths are relative to the config directory; `!secret` stays a reference; never inline secret values [D] |
| 4 | Reload vs restart | Change doesn't apply, or user restarts unnecessarily | Automations/scripts/scenes/templates/core config/themes reload via quick reload; a newly added integration in YAML needs a restart; recorder/logger changes need a restart [D] |
| 5 | Renamed entity breaks YAML | Automation stops fire or logs "Referenced entities … are missing" | Search config for the old id; update triggers/actions; explain that HA does not migrate YAML references [D] |
| 6 | Replaced device → unknown device | Automation unavailable, repair "Unknown device" | Re-select device in each device trigger/action; explain 30-day removal retention [D] |
| 7 | Template returns `unknown`/`unavailable` | Template sensor goes unknown after a device drops | Use `states('x')`/`is_state`, handle `unknown`/`unavailable` explicitly, test with `ha_render_template` before saving [D]/[A] |
| 8 | State value vs UI label mismatch | `to: "Open"` never matches | Compare raw states (`on`/`off`); check the state in **Settings → Tools → States** [D] |
| 9 | `from:` state + unavailable in between | Automation doesn't fire after device reconnect | Remove `from:` if any previous state is acceptable [D] |
| 10 | `for:` resets / wait semantics | Timers restart; waits never finish | Explain: `for:` restarts when the entity leaves the state; `wait_for_trigger` only sees future changes; use `wait_template` for current-state checks [D] |
| 11 | Automation mode ignored | Logs "Already running" / "Maximum number of runs exceeded" | Explain modes (`single` default, `restart`, `queued`, `parallel`) and raise `max` only when intended [D] |
| 12 | UI-managed vs YAML automations | Hand-editing `automations.yaml` gets reformatted or breaks ids | `automations.yaml` is UI-managed (must stay a list); use the editor or put YAML automations in `configuration.yaml` [D] |
| 13 | Traces missing | User can't see why it ran | Traces need an `id`; only the last `stored_traces` (default 5) are kept [D] |
| 14 | Secrets/values leaking | Agent quotes API keys or passwords | Redaction (§4.6); never read `secrets.yaml` values or `options.json` [A] |
| 15 | Recorder DB not shrinking | Purge ran but disk still full | `auto_repack` only on the second Sunday; `recorder.purge` with `repack: true`; SQLite needs free temp space ≥ DB size [D] |
| 16 | Recorder hidden history | Diagnosing an entity with no history | Check recorder `exclude` before concluding "no data"; don't add exclusions that hurt future diagnosis [D] |
| 17 | DB migration + restart/update | Restart/update refused or slow after upgrade | Check `/api/core/state` migration flags; wait for the notification to clear [D] |
| 18 | Backup/restore concurrency | "Wait and restart", restore fails | Check jobs before restart/restore; never restore during a backup [D] |
| 19 | App `config.yaml` invalid | App never appears in Local apps | Supervisor log names the parse error; fix and `sup_store_reload` [D] |
| 20 | App version not bumped | Update not offered after edit | Bump `version`; or rebuild with `force` for the dev loop [D] |
| 21 | `image:` present in local app | Local changes ignored | Comment the `image` key during development [D] |
| 22 | CRLF in `run.sh` | App starts then fails with unrelated-looking error | Enforce LF on scaffolds and validate line endings [D] |
| 23 | Ingress vs port confusion | Port exposed unnecessarily or ingress URL 502 | Ingress needs `ingress: true` + `ingress_port` server, no host port; `panel_admin` controls sidebar visibility [D] |
| 24 | Architecture mismatch | App `available: false` / install fails | Check `/info.arch`/`supported_arch` against `arch:`; `GET /store/addons/<app>/availability` explains it [D] |
| 25 | `.storage` edits | Integrations break after restart | Never edit `.storage`; use UI/config flows [A] |
| 26 | Administrator proxy illusion | Agent assumes read_only is enforced by HA | The proxy acts as HA admin; enforce read-only in the plugin [D] |
| 27 | Safety-domain service call | Unlocking a door as a "test" | Safety-domain catalogue + confirmation; never "just test" a lock/garage/alarm [A] |
| 28 | Notification target assumptions | Message goes nowhere or to everyone | Resolve `notify.*` targets from `ha_get_services`; confirm the person; default to persistent notification [D]/[A] |
| 29 | Dashboard storage vs YAML | Editing `.storage/lovelace` or wrong dashboard mode | Detect dashboard mode; storage dashboards via UI/WS, YAML dashboards require YAML mode config [A]/[U] |
| 30 | Time zone / DST in triggers | Automation fires at the wrong hour or not on DST days | Use HA timezone from `/api/config`; warn about skipped/repeated DST hours [D] |

---

## 10. Open questions and assumptions to verify against a live HA

1. **WS command contract** for `trace/*`, `system_log/list`, `repairs/list_issues`, registry lists, `lovelace/config*`, `extract_from_target`: confirm names, payloads, and HA-version range (2024.x–2026.11). Fallbacks are defined above; the plugin must degrade to `UNSUPPORTED` and the UI path. [U]
2. **Trace retention/storage**: where traces live between restarts, and whether `trace/get` returns saved traces after a restart, so the diagnostics skill knows when to say "the trace is gone". [U]
3. **`ha_list_automations` derivation**: confirm that `last_triggered`, `mode`, and `current` are exposed as automation state attributes for both YAML and UI automations on current HA. [A]
4. **Reload matrix keys**: confirm the exact per-domain reload action set on 2026.11 (`automation.reload`, `script.reload`, `scene.reload`, `template.reload`, `input_boolean.reload`, `frontend.reload_themes`, …) from `GET /api/services`; ship `ha_reload` targets from that catalog rather than a hardcoded list. [A]
5. **Dashboard write path**: validate `lovelace/config/save` behavior and conflict detection for storage-mode dashboards before shipping `ha_save_dashboard`. [U]
6. **Option visibility**: confirm that `GET /addons/<slug>/info` with `hassio_role: manager` returns other apps' options on current Supervisor and design the redactor accordingly (docs say options can be empty unless manager/admin; we are manager). [D]
7. **Enforcement point for config writes**: if DSH's native `write`/`edit` tools remain mounted for the agent, they can bypass `config_write` validation/snapshots. The Lead/container work must decide: unmount native write/edit for the HA workspace, or accept prompt-level discipline (not acceptable for a product). [A]
8. **Scheduler ownership**: monitor scheduling must live in the plugin host (outside chat sessions); confirm with `dsh-container.md` how timers survive idle sessions in the add-on container. [A]
9. **Add-on naming**: decide whether user-facing copy says "app" everywhere in 2026.11+ (docs and UI already do) or keeps "add-on" for continuity with the existing ecosystem and this brief. [D]/[A]
10. **Notification permissions**: which companion builds still expose legacy `notify.<service>` vs the new `notify` entities, so `notify_user` can pick the right action (`notify.send_message` requires a notify entity). [D]/[A]

11. **Blog feed URL and payload** (`https://www.home-assistant.io/blog/feed.xml`): confirm it exists and whether it carries full content or summaries; if summaries only, the watcher must fetch each release post (bounded, cached).
12. **GitHub API limits and ETag behavior from the add-on network**: confirm unauthenticated rate limits, conditional-request support, and whether `/available_updates` already covers Core/OS/app version detection so GitHub is only needed for release-note detail.
13. **HACS inventory without `.storage`**: confirm the public default-list paths (`hacs/default`) and whether community inventory can be read without touching the local HACS data in `.storage` (which we never read).
14. **FTS5 availability** in the Node 24 build used by the add-on: check `sqlite_compileoption_used('ENABLE_FTS5')`; keep the JSONL/BM25 fallback if absent.
15. **Release-note extraction stability**: section headings vary ("Breaking changes" vs older "Backward-incompatible changes"); confirm the extractor across the last ~12 releases before relying on severity matching.
16. **Community/HACS recommendations in v1?** Decide whether recommending HACS/custom integrations is in scope or opt-in (`knowledge_sources`), given support expectations and liability.
17. **`web_search` policy**: it is provider-backed rather than a plain fetch. Default design is direct URL fetching only; confirm no routine path ever calls LLM-backed search.

---

## Appendix A — tool name contract (single source of truth)

`ha_get_config`, `ha_get_states`, `ha_get_state`, `ha_get_services`, `ha_list_registry`, `ha_get_history`, `ha_get_logbook`, `ha_get_error_log`, `ha_get_system_log`, `ha_get_repairs`, `ha_list_automations`, `ha_get_automation_trace`, `ha_render_template`, `ha_get_config_check`, `ha_get_dashboard`, `ha_save_dashboard`, `ha_reload`, `ha_restart`, `ha_call_service`, `sup_get_info`, `sup_get_resolution`, `sup_get_updates`, `sup_list_addons`, `sup_get_addon`, `sup_set_addon_options`, `sup_addon_logs`, `sup_addon_start`, `sup_addon_stop`, `sup_addon_restart`, `sup_addon_install`, `sup_addon_update`, `sup_addon_uninstall`, `sup_addon_rebuild`, `sup_get_store`, `sup_store_reload`, `sup_get_logs`, `sup_backup_list`, `sup_backup_info`, `sup_backup_create`, `sup_backup_restore`, `sup_job_status`, `sup_core_update`, `memory_get`, `memory_refresh`, `memory_update`, `config_list`, `config_read`, `config_search`, `config_write`, `config_edit`, `config_delete`, `config_snapshot`, `config_restore`, `addon_scaffold`, `addon_validate`, `addon_build`, `monitor_probe`, `monitor_digest`, `monitor_configure`, `monitor_history`, `notify_user`, `ha_news_scan`, `ha_news_digest`, `knowledge_search`, `ha_compat_scan`, `ha_recommend`.

Naming rules: snake_case; prefix encodes owner (`ha_`, `sup_`, `config_`, `addon_`, `monitor_`); verbs read (`get`, `list`, `search`) vs write (`write`, `edit`, `set`, `create`, `restore`, `start`, `stop`, `restart`, `install`, `update`, `uninstall`, `rebuild`); no abbreviations except `sup`/`config`/`addon`; never rename a tool without updating all four skills and this appendix.