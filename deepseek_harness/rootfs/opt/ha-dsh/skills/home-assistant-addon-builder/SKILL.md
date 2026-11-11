---
name: home-assistant-addon-builder
description: >-
  Build, install, update, and troubleshoot Home Assistant apps (add-ons) from the
  agent: gather requirements, scaffold a local app, lint it, build and install it
  through the Supervisor, fix build/start failures from logs, and do it with
  verified backups and explicit approval. Also covers safe app updates,
  uninstalls, and restore guidance. Use when the user asks for a new app or to
  manage an existing one.
whenToUse: >-
  Use for "build me an app that…", "scaffold an app", "install/update/stop app
  X", "my app won't start", "make my app show in the sidebar", or "back up
  before updating". Use the diagnostics skill for entities and automations, and
  the config skill for YAML-only changes.
---

# Home Assistant: app (add-on) builder and manager

Home Assistant calls add-ons **apps** in the current UI; the Supervisor API paths still say `/addons`. Use the user's wording but the current UI paths: **Settings → Apps**, **App store**, **Local apps**. Every interruptive action follows the safety prompt: plan as short bullets, verified backup, explicit confirmation.

## First move

1. `memory_get` with `sections: ["inventory", "preferences", "backups"]` — what apps exist, versions, disk, user's naming, last backup.
2. Check the capability gates: `allow_addon_management` off (the default) means install/start/stop/options are unavailable; `allow_addon_build` off means scaffolding is unavailable. Say so plainly and offer read-only planning or the manual UI path — never work around a gate.
3. `sup_get_info` with `sections: ["system", "host", "core"]` — architecture (`arch`, `supported_arch`), machine, disk free, Core version. Reject a scaffold whose `arch` list cannot run here.
4. For an existing app: `sup_get_addon {slug}` and `sup_addon_logs {slug}` before proposing anything.
5. For a new app: confirm requirements first (§Requirements), then scaffold. Never generate files from a one-word request.
6. If the user is exploring ("is there an app for…", "what should I use"), run Playbook 0 before designing anything.

## Required tools

| Phase | Tools |
|---|---|
| Requirements | conversation + `sup_get_info`, `sup_list_addons` |
| Scaffold | `addon_scaffold` (writes `/addons/<slug>/`), `config_read`/`config_list` to review |
| Lint | `addon_validate` |
| Build/install | `sup_store_reload`, `sup_addon_install`, `sup_addon_rebuild`, `sup_job_status` |
| Run/observe | `sup_addon_start`, `sup_addon_logs`, `sup_get_logs` (Supervisor log for build/config errors), `sup_job_status` |
| Configure | `sup_get_addon`, `sup_set_addon_options` (validate first) |
| Update/uninstall | `sup_addon_update`, `sup_addon_uninstall` (DES), backups |
| Backup/restore | `sup_backup_list`, `sup_backup_info`, `sup_backup_create`, `sup_backup_restore` (DES) |
| Updating HA itself | `sup_get_updates`, `sup_core_update` |
| Recommend/anticipate | `knowledge_search`, `ha_recommend`, `ha_compat_scan`, `ha_news_scan` |
| Evidence/verify | `ha_get_states`, `ha_get_state`, `ha_get_config_check` |
| Memory | `memory_update` (record app inventory, decisions, quirks) |

## Requirements (ask as one short list, not an interview)

1. **Name + purpose** — one sentence each.
2. **Shape** — web UI (ingress, recommended, or a host port), background service, MQTT bridge, API poller.
3. **Inputs** — external HTTP API (URL + auth type), serial/USB/GPIO device, MQTT, local files, none. Serial/USB/GPIO require explicit hardware capabilities and lower the security rating.
4. **Needs Home Assistant** — call HA API? create entities (MQTT discovery)? manage other apps (almost always no)?
5. **Settings** — the options the user will change, with types; secrets are `password` options, never literals.
6. **Persistence** — `/data` (private, survives updates) or user-editable files (`app_config`).
7. **Architectures** — default `aarch64` + `amd64`.
8. **New app or change** — new folder vs extend an existing local app.

Everything else has a safe default; show the defaults you chose instead of interrogating. Scaffold only after 1–3 and 6 are known.

## Playbook 0 — recommend before building

1. Extract the real need and constraints from the user (what it must do, cloud or not, effort, hardware, budget).
2. `ha_recommend {need, constraints}` — local retrieval over the knowledge index, store catalog and installed inventory; it returns 2–3 scored options with fit/effort/risk/maintenance and sources, and never installs.
3. Check the recommendation against what is already installed (`sup_list_addons`, `ha_get_config`) — the best answer is often an integration or an app the user already has.
4. Present the tradeoff table, say which you would pick and why, label community/HACS options as community-supported, and cite dates. Then ask which one to set up.
5. Only after the user picks an app do you enter Playbook A (new local app) or Playbook C (install/update an existing app).

If the knowledge cache is stale or offline, say "knowledge is from <date>; want me to refresh?" and never invent a recommendation from memory alone.

## Playbook A — build a new app

1. Summarize the plan in ≤5 bullets and get agreement (this is a change to `/addons`).
2. `addon_scaffold` with the requirements. Defaults: `expose: "ingress"`, `ingress_port: 8099`, `base_image: "ghcr.io/home-assistant/base:3.24"`, `init` false, `version: "1.0.0"`, arch `aarch64`+`amd64`.
3. `config_read` the generated `config.yaml`, `Dockerfile`, `run.sh` and confirm they match the intent (especially option names and the `map` entries).
4. `addon_validate {slug}`. Fix every error; for warnings, surface the security-relevant ones (privileged/host network/full access) and get explicit consent before proceeding.
5. `sup_store_reload` — the Supervisor reads the local apps folder; the app appears under **Local apps** after **Check for updates**.
6. `sup_addon_install {store_slug: "local_<slug>", background: true}` → `sup_job_status {wait: true}` until done.
7. `sup_addon_start {slug}`, then `sup_addon_logs {slug, lines: 100}`. Build errors appear in `sup_get_logs {target: "supervisor"}`, not in the app log.
8. Verify the function: for ingress, confirm the app is listening and the ingress panel exists; for entity-producing apps, `ha_get_states` for the new entities; for MQTT, check the broker log and the discovered device.
9. Present the result: what was built, where the code is, exact install/open path, how to change it later, where the logs are, backup note. Record in memory: app slug, version, purpose, quirks.

## Playbook B — fix a build or start failure

Use the symptom map before editing anything:

| Symptom | Where to look | Fix |
|---|---|---|
| App does not appear under Local apps | `sup_get_logs {target:"supervisor"}` | invalid `config.yaml` (YAML syntax or disallowed value); fix, `sup_store_reload` |
| Install/build job fails | job `errors` + Supervisor log | `Dockerfile` build error (package name, base image, missing file) |
| Builds but exits immediately | `sup_addon_logs` | `run.sh` CRLF, missing shebang, `init` wrong, missing option, crash on startup |
| Starts but no UI | ingress/port mismatch; app log | `ingress: true` with a server on `ingress_port`, or `ports` mapping; check bind address `0.0.0.0` |
| Update not offered | compare `version` in `config.yaml` with installed | raise `version`, or for the dev loop `sup_addon_rebuild {force: true}` |
| Local change ignored | `sup_get_addon` shows published image | comment out `image:` in `config.yaml` while developing |
| App unavailable on this host | store availability | fix `arch`/`machine`, or the `homeassistant` minimum version |

Loop: edit with `config_edit` (respect `base_sha256`), bump `version`, `addon_validate`, `sup_addon_rebuild {force: true}`, `sup_job_status`, `sup_addon_logs`. Stop after two identical failures and report.

## Playbook C — install or update an existing app safely

1. `sup_get_store` / `sup_get_addon` — check `update_available`, `version_latest`, availability, security rating, auto-update, watchdog.
2. `ha_compat_scan {target: {kind: "app", slug}}` — show breaking/deprecation findings for this update next to the plan; the user acknowledges `breaking` findings before proceeding.
3. Read the changelog (`sup_get_store` includes it; `/store/addons/<slug>/changelog` under the hood) and the `breaking_versions` note. Summarize the change for the user.
4. Present the plan as bullets: what updates, downtime, backup, undo. Example: "**What:** update Mosquitto 6.4 → 6.5. **Affects:** about 30 s, MQTT devices reconnect. **Undo:** app backup before update. **Why:** bug fixes."
5. Create the backup: `sup_addon_update {slug, backup: true, background: true}` uses the Supervisor's built-in pre-update backup; verify the job and, if the app matters, that a backup exists with `sup_backup_info`.
6. Poll `sup_job_status`; then `sup_addon_logs` for new fatal errors; then `ha_get_states` for the app's entities/devices.
7. On failure: do not retry blindly. Read logs, report, and offer rollback (restore the backup, DES, with confirmation).
8. Record the new version and outcome in memory.

## Playbook D — uninstall, stop, or reconfigure

- Stop: `sup_addon_stop` — explain which dependent entities will become unavailable first.
- Reconfigure: `sup_set_addon_options` (validates first); tell the user options take effect on next start, then offer `sup_addon_restart` with confirm.
- Uninstall: DES. First `sup_backup_create` partial for that app (`addons: [slug]`) when configuration would be lost, then `sup_addon_uninstall {slug, remove_config: <user's choice>}`. State clearly whether the app's public config folder is removed. Verify it is gone from `sup_list_addons`.
- Restore an app backup: DES, dry-run plan + token + confirmation; state what versions are inside, that apps restart, and that newer config may be overwritten.

## Playbook E — back up before Core/OS updates

1. `sup_get_updates` and `sup_get_info` — versions, `version_pending` (OS updates wait for a reboot), channel.
2. `sup_backup_create` full (or rely on `sup_core_update {backup: true}`) and verify with `sup_backup_list`/`sup_backup_info`; record in the ledger.
3. `sup_core_update {backup: true, background: true}` → poll the job → verify `/api/config.version` changed and key entities recovered.
4. OS update: `sup_get_info` shows the pending version; the host reboot is a separate, interruptive step — explain and confirm.
5. Report what changed and what to watch; do not update multiple layers (Core + OS + apps) in one unverified batch.

## Presentation template (non-expert)

- Built/updated: name, version, one-line purpose, where the code lives (`/addons/<slug>`).
- Use it: **Settings → Apps → App store → Check for updates → Local apps → Install → Start**, then the sidebar entry (ingress) or `http://<ha-host>:<port>`.
- Change it later: edit files, Check for updates → Rebuild; raise `version` for a normal update.
- Logs: app **Log** tab; Supervisor log for store/config/build errors.
- Safety: what privileges the app has, and what backup exists.

## Guardrails

- No `privileged`, `full_access`, `host_network`, `host_pid`, `docker_api`, or `apparmor: disable` without explicit consent that names the risk; explain that each lowers the app's security rating.
- No secrets in `config.yaml`, `Dockerfile`, `README.md`, options defaults, or logs. Secrets go in `password`-typed options (users can `!secret` reference their own).
- Always LF line endings for shell scripts; always raise `version` before a normal update; never generate deprecated `build.yaml`/`snapshot*` keys.
- Do not start a build for a requirement you have not confirmed; do not silently pick a different feature than the user's.
- App operations are interruptive: update/install/uninstall/restart each need their own confirmation; a prior "yes" to one does not authorize the next.
- Do not install apps from repositories the user did not approve; do not add repositories.
- Keep the backup set bounded (§4.13): verified before risky operations, prune only `dsh-*` backups, never the user's.
- If the requested app duplicates an existing official app or integration, say so before building.
- Recommendations are evidence, not orders: cite URL + date, label HACS/community projects, show the trade-offs, never install while recommending, and say when the knowledge cache is stale (§7).
- Before an app update, run `ha_compat_scan` and surface `breaking` findings in the plan; the user acknowledges them before the update.
- Record what you built in memory; the next session should not re-ask what the app is for.

## Worked examples

**1. "Build me an app that shows the solar forecast on a web page"**

- Plan bullets: new local app `solar_page`, ingress UI, static page fetching the forecast from an HTTP API keyed by an option, no HA API needed.
- Calls: `addon_scaffold {name: "Solar page", slug: "solar_page", purpose: "...", expose: "ingress", language: "python", options: {api_key: ""}, schema: {api_key: "password"}}` → `addon_validate` → `sup_store_reload` → `sup_addon_install {store_slug: "local_solar_page", background: true}` → `sup_job_status` → `sup_addon_start` → `sup_addon_logs`.
- Verify: app log shows the page server started; tell the user to open the sidebar entry and set the API key in the app's Configuration tab; note that changes need a restart.
- Memory: app slug, purpose, ingress, option name (never the value).

**2. App won't start after I edited it**

- `sup_get_addon` shows installed, state `error`; `sup_addon_logs` shows `syntax error near unexpected token` and CRLF-looking output; `config_read` of `run.sh` confirms CRLF (the scaffold tool reports it; `addon_validate` flags it).
- Fix line endings, `addon_validate`, bump version, `sup_addon_rebuild {force: true}`, poll, `sup_addon_start`, verify logs. Record the quirk: "run.sh must stay LF; editors on Windows can reintroduce CRLF."

**3. Update the Zigbee app with a backup**

- `sup_get_addon` → 2.4.0 → 2.5.0 available; changelog mentions a coordinator migration; disk 41 GB free.
- Present bullets, get confirmation. `sup_addon_update {slug: "core_zigbee2mqtt", backup: true, background: true}` → poll job → `sup_addon_logs` clean → `ha_get_states` shows Zigbee entities back within 2 minutes → report and record. If entities do not recover in 5 minutes, offer restore of the pre-update backup (DES, with confirmation) instead of a second restart.
