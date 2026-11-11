---
name: home-assistant-config
description: >-
  Make safe, minimal Home Assistant configuration changes: automations, scripts,
  scenes, template sensors and templates, helpers, and dashboards. Use when the
  user asks to add, change, fix, or explain YAML configuration, and for edits
  that must be validated, reloaded without a restart when possible, and
  reversible. Always snapshots files, validates before reload, and records the
  change in memory.
whenToUse: >-
  Use for "create an automation", "add a template sensor", "make a helper",
  "fix my YAML", "why was this automation written this way", "put this on my
  dashboard", or any request whose result is a configuration edit. Use the
  diagnostics skill first when the user reports something broken and the cause
  is unknown.
---

# Home Assistant: safe configuration changes

You are editing a live system. The safety system prompt outranks this skill; this skill is the procedure. Read §4 of `ha-domain.md` if you need the rationale, but never skip its rules.

## First move (every time)

1. `memory_get` with `sections: ["inventory", "preferences", "intent"]` — you need to know the user's names, existing automations, and what has been changed recently.
2. `ha_get_config` with `sections: ["core", "state"]` — confirm HA is running, note the time zone, and check `recorder_state.migration_in_progress` (never restart during a migration).
3. If the add-on is in `read_only` mode (the default), stop before the first write and explain how to enable configuration changes (Settings → Apps → DeepSeek Harness → Configuration → `read_only: false`). Never try to work around a capability gate.
4. Locate the real target file: `config_read` on `configuration.yaml` and follow `!include` / `!include_dir_*` / `packages:` before assuming the file name. Never guess.
5. Resolve every entity ID with `ha_list_registry` or `ha_get_states`; resolve every action name with `ha_get_services`. Never invent either.
6. If the feature may have changed recently (a new option, a renamed key, an integration the user just updated), check before writing: `ha_compat_scan {target: "upcoming"}` for deprecations that affect this install and `knowledge_search` for the integration's current docs. Cite what you used in the reply.

## Required tools

| Tool | Use |
|---|---|
| `config_list`, `config_read`, `config_search` | find the owning file, read current content, get `sha256` |
| `config_write`, `config_edit` | the only sanctioned way to change `/config` files; both require `base_sha256` and snapshot by default |
| `ha_get_config_check` | must be `valid` before reload/restart |
| `ha_reload` | apply YAML without a restart (`targets: ["automations"]`, `["scripts"]`, `["templates"]`, `["core_config"]`, `["input_helpers"]`, `["all"]`) |
| `ha_restart` | only when the change genuinely needs a restart |
| `ha_get_services`, `ha_list_registry`, `ha_get_states` | ground truth for names and targets |
| `ha_render_template` | test every template with real values before saving |
| `ha_call_service` | trigger a test run (`automation.trigger`, `script.turn_on`) |
| `config_snapshot`, `config_restore` | file-level backup/rollback |
| `ha_get_dashboard`, `ha_save_dashboard` | storage-mode dashboards (verify availability first; fall back to UI instructions) |
| `memory_update` | record intent, changes, quirks |

## Decide where the YAML belongs before writing

| Situation | Destination | Reload |
|---|---|---|
| Automation created in the UI, has an `id` | `automations.yaml` — **UI-managed**, keep it a list; do not restructure it by hand | `automations` |
| Automation the user wants in YAML | labeled `automation <name>:` block in `configuration.yaml`, or a file included via `!include_dir_*` / `packages:` | `automations` |
| Script | `scripts.yaml` (UI-managed) or YAML `script:` section | `scripts` |
| Template sensor / binary sensor / template helper | `template:` block (or its include file) | `templates` |
| Helper (input_boolean, input_number, counter, timer, schedule) | YAML helper keys only if the user accepts YAML; UI helpers live in `.storage` and are **not editable** by us | `input_helpers` |
| Dashboard | detect mode: YAML dashboards via config files, storage dashboards via `ha_save_dashboard`; never edit `.storage/lovelace*` | dashboard refresh |

Rules for the YAML itself: 2-space indentation, no tabs; top-level `triggers:`/`conditions:`/`actions:`, item keys singular (`- trigger:`, `- condition:`, `- action:`); `action:` not `service:`; `trigger:` not `platform:`; never mix old and new forms. New automations get an `id` (string) so traces work; YAML automations that should be editable in the UI must move to `automations.yaml` with a unique `id`.

## Playbook A — create or change an automation

1. Restate the intent as trigger → condition → action, using the user's words. Ask at most one question if a piece is missing (e.g. "which lights?"). Do not ask for things you can look up.
2. Resolve entities and actions (`ha_list_registry`, `ha_get_services`). Check the target entities are not `unavailable`.
3. Draft the YAML. Test every template with `ha_render_template` using current states.
4. `config_read` the target file (or `config_write` with `base_sha256` from the read), then `config_edit` to insert the block. Show the user only the diff.
5. `ha_get_config_check`. If invalid: `config_restore` or `config_edit` back, show the exact error, stop.
6. `ha_reload` with the narrowest target. Never `all` just because it is convenient.
7. Verify: `ha_list_automations` for the new entity, or trigger it once with `ha_call_service {domain: "automation", service: "trigger", target: {entity_id: ...}}` and confirm the effect with `ha_get_state` / `ha_get_automation_trace`.
8. `memory_update` with `record_change` (what, file, why) and, if you learned intent, set `curated.intent.<automation>`.

Restart only if: a YAML integration is added for the first time, a `lovelace:` mode change is required, or the user asks. Say why in one clause.

## Playbook B — template sensor / template helper

1. Build the expression from real state: `ha_get_states` for the inputs, then `ha_render_template` with the draft. Handle `unknown`/`unavailable` explicitly (`states('sensor.x') not in ['unknown','unavailable']`, `has_value`, `is_state`).
2. Prefer a `template:` sensor with `state` + `unit_of_measurement` + `availability` over a template trigger automation.
3. Write, config-check, `ha_reload` `templates`.
4. Verify the entity appears with `ha_get_state` and a numeric state within one minute; if it stays `unknown`, re-render and show the user the intermediate values.
5. For statistics/history, explain that the entity must be recorded (not excluded by `recorder`) and that long-term statistics need a `state_class`.

## Playbook C — helpers, scripts, scenes

- Helpers: prefer the native helper YAML keys (`input_boolean:`, `input_number:`, `counter:`, `timer:`, `schedule:`); reload `input_helpers`; verify with `ha_get_state`. If the user created the helper in the UI, say it lives in `.storage` and offer either a YAML helper (different entity) or the UI steps.
- Scripts: one `script:` entry with `sequence` using `action:`; reload `scripts`; test with `ha_call_service {domain:"script", service:"turn_on", target:{entity_id:"script.x"}}`.
- Scenes: `scene:` entries capture `entities:` state snapshots; reload `scenes`; apply with `scene.turn_on`. Explain that scenes are snapshots, not rules.

## Playbook D — dashboards

1. Detect mode: `config_read configuration.yaml` and search for `lovelace:`; if `mode: yaml`, dashboards are files; otherwise the dashboard is storage-managed.
2. Storage dashboards: use `ha_get_dashboard(url_path)` then `ha_save_dashboard(url_path, config, base_sha256)` only if the tool is available; otherwise give the user the exact UI steps (edit dashboard → add card → paste YAML) instead of pretending to edit.
3. YAML dashboards: edit the dashboard YAML file, config-check, reload; some changes need a browser refresh, not an HA restart.
4. Never edit `.storage/lovelace*` or dashboard storage files directly.

## Guardrails

- One coherent change per turn. Do not bundle an automation, a template, and a dashboard rewrite into one "fix".
- `config_read` → `config_write`/`config_edit` with `base_sha256`; never blind-overwrite. If `STALE_BASE`, re-read and rebase your edit.
- Never remove or rewrite code you do not understand. If a file contains user YAML unrelated to the task, leave it byte-identical.
- Never edit `automations.yaml` structure while the UI owns it: append or edit entries only, keep it a list, keep existing `id`s.
- `homeassistant.reload_all` only after several domains changed; otherwise reload the one domain.
- Structural change (new integration, `configuration.yaml` rewrite, template file split): `config_snapshot` first; if it touches many files, offer a partial HA backup (§4.13) before reload.
- If the user asks for something that cannot be expressed safely (e.g. a `shell_command` or `python_script` to work around a missing API), say no to the workaround and propose an integration/action instead; record the decision in memory if they disagree.
- After reload, verify. "Saved successfully" is not "works".
- Prefer current syntax and documented features. If the knowledge cache or `ha_compat_scan` flags a deprecation for what you are about to write, warn the user once, cite the source, and write the replacement instead (or ask which they prefer).
- Knowledge answers are informational: cite the URL and fetch date, and never send the user's config or entity names to a web service to look something up — search by integration name only.
- End with a short user-facing summary: what changed, the file, how it was applied, how to undo, and what to check tomorrow.

## Worked examples

**1. Porch lights at sunset when someone is home**

- User: "Turn the porch light on 30 minutes before sunset if anyone is home, and off at 23:00."
- Calls: `memory_get` → `ha_list_registry {kind: "entities", filters: {domain: "light", area_id: ...}}` finds `light.porch`; `ha_get_services {domain: "light"}` confirms `turn_on`/`turn_off`; `ha_get_states` shows `person.*` entities.
- Draft uses `triggers: [{trigger: sun, event: sunset, offset: "-00:30:00"}]`, `conditions: [{condition: state, entity_id: "zone.home", state: "0"}]` (or OR over `person.*`), `actions: [{action: "light.turn_on", target: {entity_id: "light.porch"}}]`; a second time trigger at 23:00 for off.
- `config_edit` into `automations.yaml` (append list item with a new `id`), `ha_get_config_check` → valid, `ha_reload {targets: ["automations"]}`, verify with `ha_get_automation_trace` after the next run or a manual trigger.
- Reply: "Added 'Porch lights'. It turns on 30 min before sunset when the house is occupied and off at 23:00. I added it to `automations.yaml` and reloaded automations — no restart. Undo: I saved a snapshot."

**2. Average temperature template sensor**

- User: "Make a sensor for the average of the living room and bedroom temperatures."
- Calls: `ha_get_states {domain: "sensor"}` finds `sensor.living_room_temperature`, `sensor.bedroom_temperature`; `ha_render_template` with `{{ ((states('sensor.living_room_temperature') | float(0) + states('sensor.bedroom_temperature') | float(0)) / 2) | round(1) }}` returns `21.6`.
- Write a `template:` sensor with `unit_of_measurement: "°C"`, `state_class: measurement`, and `availability` template that is false when either source is `unknown`/`unavailable`.
- Check, reload `templates`, verify `ha_get_state {entity_id: "sensor.average_temperature"}` → `21.6`. Record intent in memory.

**3. Explaining an old automation before touching it**

- User: "Why does this automation look wrong?"
- Calls: `config_search {query: "alias: .*Evening"}` → `config_read` the file → `ha_get_automation_trace` for the last run.
- Answer: point out the mixed `trigger:` + `triggers:` or the `from:` that breaks after `unavailable`; propose the minimal fix and ask before editing. Do not rewrite their style wholesale.
