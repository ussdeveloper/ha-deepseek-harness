---
name: home-assistant-diagnostics
description: >-
  Diagnose Home Assistant problems from evidence: entities that are unavailable
  or unknown, automations that do not fire or act, errors after an update,
  integration setup failures, app instability, and "something changed my device"
  questions. Produces symptom, evidence, cause class, minimal fix, and confidence.
  Read-only until the cause is known; records durable quirks in memory.
whenToUse: >-
  Use when the user reports something broken or surprising. Do not use for
  creating new configuration; for that use the config skill. Do not use for
  routine health summaries; for that use the monitor skill.
---

# Home Assistant: diagnosing problems

Diagnosis is evidence work, not guessing. The user gets one clear answer with the evidence that supports it, the smallest fix, and what remains uncertain. The safety system prompt applies; you are read-only until the cause is established.

## First move

1. `memory_get` with `sections: ["quirks", "hardware", "incidents", "inventory"]` — the bug may be a known quirk ("microwave drops the kitchen sensor") or something you changed recently.
2. `ha_get_config` `sections: ["core", "state"]` — version, time zone, core state, recorder migration. This frames "since when".
3. `ha_get_repairs` and `ha_get_error_log {lines: 100}` — current system-level truth before the user's anecdote.
4. Only then narrow to the specific entity/automation/app.

## Required tools

| Tool | Use |
|---|---|
| `ha_get_state`, `ha_get_states` | current value, attributes, `last_changed`, `last_updated` |
| `ha_list_registry {kind: "entities"}` | platform, device, area, disabled/hidden flags — a "missing" entity is often disabled |
| `ha_get_history`, `ha_get_logbook` | when it changed, what changed it, outage windows |
| `ha_list_automations`, `ha_get_automation_trace` | did the automation run, why it stopped |
| `ha_get_error_log`, `ha_get_system_log`, `ha_get_repairs` | integration/platform errors and system issues |
| `ha_get_config_check` | is the configuration even valid |
| `ha_render_template` | reproduce the exact expression in a trace/condition |
| `ha_get_services`, `ha_get_history` | confirm the action exists and was actually called |
| `sup_get_info`, `sup_get_resolution`, `sup_addon_logs`, `sup_get_logs` | app/system layer when the integration lives in an app |
| `config_search`, `config_read` | where the entity/automation is referenced |
| `ha_compat_scan` | known breaking changes/deprecations for the current or upcoming version that touch installed integrations and YAML |
| `knowledge_search` | cached release-note/doc excerpts (cite URL + date); never LLM-backed web search |
| `memory_update` | add/resolve a quirk, record an incident summary |

## Evidence standard

A conclusion is only reportable when it names:

- **Symptom** — what the user sees, reproduced from data.
- **Evidence** — the exact state, log line, trace step, or registry row.
- **Cause class** — device/network, integration, configuration, automation logic, resource pressure, or platform.
- **Fix** — the minimal change, or "device-side: what the user should check".
- **Confidence** — high (direct evidence), medium (strong inference), low (heuristic).

If the evidence is incomplete, do not guess: say which single data point decides it and how you would get it (and ask before changing anything).

## Triage tree

| Symptom | First checks |
|---|---|
| Entity `unavailable`/`unknown` | history around the drop; registry (disabled?); same-platform neighbours; app health; logs for that platform; battery/signal |
| Entity never existed / disappeared | registry search; was it renamed; was the device removed >30 days ago; integration removed |
| Automation did not fire | enabled state; trace list; `from:` vs `unavailable`; raw state vs UI label; entity rename; `single` mode "Already running"; time-zone/DST |
| Automation fired but nothing happened | trace step details; condition failed; target has no matching entities; target entity unavailable; `continue_on_error`; area/floor/label target empty |
| Automation fires twice/too often | multiple triggers on the same change; attribute-only change; floating sensor; `for:` missing; mode |
| Something changed a device unexpectedly | history/logbook context; Activity details; which automation/script/scene/context; integration/app |
| Broke after update | version change; releases' breaking changes; repairs; error log signatures before/after; safe-mode question |
| Integration failed to set up | error log line, repairs issue; config entry state; if YAML integration: config check; if app: app log |
| App/add-on is down or flapping | `sup_get_addon`, `sup_addon_logs`, `sup_get_logs(target:"supervisor")`, disk/memory |
| Everything slow/unstable | recorder DB size/growth, disk free, memory, restart loop, database migration |

## Playbook A — entity unavailable or unknown

1. `ha_get_state` — capture state, attributes, `last_changed`, and whether it is `unavailable` (integration lost connection / device offline) or `unknown` (integration has no value yet).
2. `ha_get_history {entity_ids:[id], start:"-12h"}` — when did it drop, is it intermittent, did it correspond to a reboot or app restart.
3. `ha_list_registry {kind:"entities", filters:{domain}}` — disabled? device id? platform? Then check 2–3 sibling entities of the same platform: all down = integration/device gateway; one down = that device.
4. `ha_get_error_log` and `ha_get_system_log` filtered by the platform/name. `ha_get_repairs` for a setup failure. If the platform is provided by an app: `sup_get_addon`/`sup_addon_logs`.
5. Conclude: offline device (battery/power/network), integration/app down, disabled entity, or upstream service. Give the user the smallest next step — "check the battery in the hallway sensor", "restart app X" (with confirmation), or "this is a known integration issue; here is the evidence and the repair".
6. If it recovers after a fix, `memory_update` `resolve_quirk` / `record_change`. If it is intermittent after this session, `add_quirk` with the pattern and what to watch.

## Playbook B — automation did not fire

1. `ha_list_automations` — is it enabled? `last_triggered` null or old? This is the fastest discriminator.
2. `ha_get_automation_trace {entity_id}` — list recent runs and the last run's trigger decision. If no trace exists, traces may need an `id` or the run is older than `stored_traces`.
3. Check the four documented classics against live values: the trigger's `to:`/`from:` compared with `ha_get_state` (raw states, not UI labels); whether the entity passed through `unavailable`; whether a `for:` timer restarted; whether the run was blocked by `single` mode ("Already running").
4. `config_search` for the entity id — the automation may reference a renamed entity (HA does not rewrite YAML on rename).
5. If a template trigger/condition is involved, `ha_render_template` with the current state and compare to expectation.
6. Report cause + fix. Fix via the config skill: snapshot, edit, check, reload, verify.

## Playbook C — automation fired but nothing happened

1. Trace → find the step marked "Stopped on error" or "condition failed"; read the step details.
2. Condition failed: re-check the condition against current values; if it uses a template, render it.
3. Action failed: `ha_get_state` the target; `ha_get_services` confirm the action name and required fields; if the target is an area/floor/label, list resolved entities; if entities are `unavailable`, HA skips them and logs a warning.
4. "No matching entities" with no error is usually a target/domain mismatch (e.g. `light.turn_on` on a `switch`).
5. Fix, then verify by triggering once and confirming the state changed — not just by the absence of errors.

## Playbook D — something changed a device and the user wants the cause

1. `ha_get_history {entity_ids:[id], start:"-24h"}` — exact timestamp.
2. `ha_get_logbook {entity_ids:[id], start:"-24h"}` — the Activity entry names the automation/script/person/context when recorded; "No cause was recorded" means outside HA (device app, physical button, another system).
3. If an automation is named, `ha_get_automation_trace {entity_id, run_id}` around that time and explain which condition/action path ran.
4. Report the cause without blaming: "at 18:42 the 'Evening lights' automation ran because motion was detected; it turned the porch light on." If outside HA, say so and suggest where to look.

## Playbook E — "everything broke after the update"

1. `ha_get_config` for the current version; `memory_get.inventory.versions` for the previous one.
2. `ha_get_repairs` — post-update issues are usually listed with the affected integration.
3. `ha_get_error_log` — group new signatures by integration; report the top 3.
4. If the system is unstable: recommend safe mode as a diagnostic step (restart in safe mode is a `ha_restart {mode:"safe_mode"}` after confirmation) and explain what safe mode proves.
5. If the symptom is version-specific: `ha_compat_scan {target: "upcoming"}` and, for the affected integrations, `knowledge_search` over the cached release notes. Quote the breaking-change entry with its URL and version. If the cache is stale, say "knowledge is from <date>" and offer `ha_news_scan`.
6. If the topic is not in the cache, say you cannot read it offline and give the URL pattern (`home-assistant.io/latest-release-notes/`); never fabricate a changelog entry.
7. Do not mass-edit YAML to silence errors. Fix one integration at a time.

## Guardrails

- Read-only until the cause is known. No "try a restart and see" as a first step; restarts are disruptive and destroy diagnostic state (traces, running automations).
- Never "fix" a symptom by hiding the entity, disabling the automation, or excluding it from the recorder. Those are the user's data and alarms; propose, do not silently do.
- Do not delete or rewrite the user's automations during diagnosis; propose the diff.
- One hypothesis at a time; if two explanations fit, say which evidence would separate them.
- Distinguish the layers: HA core / integration / device / app / network. Do not blame HA for an offline device.
- Everything you report must be reproducible from the tool output you show. No invented entity IDs, log lines, or trace steps.
- If a repair is needed that requires a device action (battery, re-pairing, firmware), say so plainly; do not pretend software can fix it.
- Record durable findings: quirks, hardware quirks, resolved incidents, and "do not touch" instructions from the user.
- Knowledge is evidence too: cite the release-note/doc URL and fetch date, label stale cache, and never send the user's entity names or config to a web search to look up a known issue — search by integration name only.

## Worked examples

**1. Hallway motion sensor unavailable since 03:12**

- Calls: `ha_get_state` → `unavailable`, `last_changed 03:12`; `ha_get_history` → dropped once at 03:12, no flapping; `ha_list_registry` → platform `zigbee2mqtt`, device `hallway_sensor`, 4 sibling sensors of the same device also unavailable; `sup_list_addons` → app `zigbee2mqtt` is `started`; `ha_get_error_log` → no integration errors.
- Conclusion: the sensor/device is offline, not HA. Ask the user to check the battery, and note the device's model in memory. Confidence high. Do not restart HA.

**2. "My morning automation didn't run"**

- Calls: `ha_list_automations` → enabled, `last_triggered` = yesterday; `ha_get_automation_trace` → last run "Stopped because a condition failed" at 07:00; trace condition is `state: "home"` for `person.alex`, but `ha_get_state person.alex` = `not_home`; logbook shows Alex left at 06:50.
- Conclusion: condition worked as designed; the user expected a different behaviour. Propose making the condition optional or notifying instead. This is a requirements change, not a bug — ask before editing.

**3. Errors after an update**

- Calls: `ha_get_config` → 2026.11.1; `ha_get_repairs` → one issue for a custom integration; `ha_get_error_log` → repeated `Error setting up entry …` for that integration; `memory_get` shows this integration was installed manually.
- Conclusion: the custom integration is not yet compatible with the new version. Give the evidence, recommend checking the integration's repository/issue tracker for a compatible release, and offer to disable only that integration's YAML while waiting (with snapshot and confirmation). Record the incident.
