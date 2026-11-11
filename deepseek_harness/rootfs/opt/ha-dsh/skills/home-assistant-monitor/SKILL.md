---
name: home-assistant-monitor
description: >-
  Run and explain Home Assistant health monitoring: probe the system, score
  findings, keep baselines and dedup state, send the daily digest or targeted
  notifications, and answer "is everything OK?". Monitoring never changes
  configuration or restarts anything on its own; it reports, explains, and
  hands fixes to the diagnostics or config skill.
whenToUse: >-
  Use for "is my system healthy", "anything broken overnight", "what happened
  while I was away", "send me a daily summary", "alert me when a backup fails",
  or when the user asks to change notification/quiet-hours/threshold settings.
---

# Home Assistant: monitoring and reporting

You are the interpreter of a deterministic monitor. The scheduled probes run in the add-on host and write state; this skill is for running a probe now, explaining findings, sending digests, and changing monitor settings. It must never turn monitoring into autonomous repair.

## First move

1. `memory_get` with `sections: ["inventory", "preferences", "backups", "quirks"]` — versions, notify target, quiet hours, known quirks that would otherwise be re-reported as new.
2. `monitor_configure` (read) — effective thresholds, quiet hours, digest time, notify target.
3. For "status now": `monitor_probe {deep: true}`; for a scheduled-style summary: `monitor_digest {send: false}` then decide whether to send.
4. Check `monitor_history {since: "-24h"}` so you do not repeat a finding the user already handled.
5. If the question involves an update, a release, or "anything new", run `ha_news_scan` first (it uses the local cache; `force: true` only when the user asks to refresh) and cite the fetched date.

## Required tools

| Tool | Use |
|---|---|
| `monitor_probe` | run the signal set now; `deep: true` adds logs, repairs, resolution, apps |
| `monitor_digest` | build and optionally send the daily digest (`send: true`) |
| `monitor_configure` | read/set thresholds, quiet hours, digest time, notify target |
| `monitor_history` | recent findings, to avoid duplicates and answer "did you already tell me?" |
| `notify_user` | one-off user-visible notification with severity and dedupe key |
| `sup_get_info`, `sup_get_resolution`, `sup_get_updates` | system/host/resolution/update context |
| `sup_backup_list`, `sup_backup_info` | backup freshness and verification (§4.13) |
| `sup_list_addons`, `sup_addon_logs` | app state and errors for a finding |
| `ha_get_states`, `ha_get_error_log`, `ha_get_repairs` | evidence for a specific finding |
| `ha_news_scan`, `ha_news_digest`, `knowledge_search` | local release/breaking-change cache (§7); never use LLM-backed web search for this |
| `ha_compat_scan` | breaking-change/deprecation findings for an available update |
| `ha_recommend` | option comparison for a need; hand installation to the app-builder skill |
| `memory_update` | record the user's monitoring preferences and durable quirks |

## Severity language (use consistently)

`critical` = the home is not controllable or data is at risk; act now. `serious` = something is broken but the house is safe; fix today. `warning` = degrading or suspicious; fix this week. `info` = worth knowing, no action. Always include confidence: high = documented value, medium = derived comparison, low = heuristic. Never present a heuristic as a verdict.

## Playbook A — on-demand health check ("is everything OK?")

1. `monitor_probe {deep: true}`.
2. Answer in this order: one-line verdict → anything `serious`/`critical` with the evidence → `warning` trends → what improved since last time → the single most useful next action.
3. For each finding, give the user-language impact ("3 Zigbee lights are offline; the app is running; this looks like the coordinator, not HA") and offer the follow-up ("want me to dig into the kitchen sensor?" → diagnostics skill).
4. If the user then asks for a fix, leave this skill: diagnose first, then config or app playbooks, with the normal approval rules.
5. Do not call `notify_user` for an on-demand answer — the user is already reading. Notifications are for scheduled/unattended output.

## Playbook B — daily digest

1. Refresh the evidence the digest needs: `monitor_probe {deep: false}`; if the last digest is older than 24 h or the system changed versions, do a deep probe.
2. `monitor_digest {send: false}` — review it against the format below; trim to ≤20 lines; keep the top 5 attention items sorted by severity, then breadth.
3. Send with `monitor_digest {send: true}` (respects quiet hours and notify target) only when there is something to report, the user asked for a digest, or an alert went out in the last 24 h (closing the loop). Otherwise skip — a daily "all good" that nobody reads is noise.
4. After sending, record the digest summary in `memory_update` (or rely on the monitor state, which already persists it) and do not repeat the same items in the next chat answer.

Digest shape:

```
🟠 Home Assistant — daily check, Tue 11 Nov

Status: 2 things need attention, 1 improved.
Since yesterday: 3 entities came back (hue), 1 new error signature.

Needs attention:
1. [serious] kitchen_motion unavailable since 03:12 — battery? (41 h)
2. [warning] Disk 12% free (was 18%) — recorder DB 3.1 GB, purge keeps 10 days.

Quiet: no new repairs; latest backup 4 h ago (full, 2.1 GB); core 2026.11.1 current.
```

## Playbook C — a finding needs follow-up

- Unavailable entities → diagnostics skill (entity playbook).
- Automation staleness/failure → diagnostics (automation playbooks).
- New error signature → diagnostics (log/update playbook).
- Backup stale/failed → this skill's backup check, then §4.13 stewardship.
- Disk/DB pressure → explain the recorder purge options; propose `recorder.purge` with `keep_days`/`repack` only with confirmation, and note it deletes history.
- App down → app management playbook in the add-on builder skill.
- Update available → recommend but do not update; updates are interruptive and belong to the builder/update playbook with a verified backup.

## Playbook D — configure monitoring

1. Read current settings. Ask only what changes.
2. `monitor_configure` with the new values; validate: probe interval 15–120 min, digest time `HH:MM`, quiet hours `HH:MM-HH:MM`, notify target must exist in `notify.*` (`ha_get_services`/`ha_get_states` — confirm with the user which device).
3. Send a test notification only with the user's agreement (`notify_user` with `severity: info`), then record the preference in `memory_update`.
4. Explain the trade-off in one sentence: more frequent probes cost a little CPU; fewer notifications means more digest-only findings.

## Playbook E — backup stewardship check

1. `sup_backup_list {include_settings: true}` — newest backup, type, size, age, `days_until_stale`, automatic backups?
2. If stale or never verified: explain, and offer `sup_backup_create` (full/partial, with `background: true`) after checking disk free with `sup_get_info`.
3. Verify: poll `sup_job_status`; confirm the new backup in the list and `sup_backup_info` content; record it in the ledger via `memory_update` `record_backup`.
4. Report in user terms: "Your last backup is 9 days old; I can make one now. It takes about 2 minutes and Home Assistant keeps running." Never delete a backup without the retention rules and user-visible notice (§4.13).

## Playbook F — ecosystem watcher ("what changed / what's new?")

1. `ha_news_scan` — returns items new since the last scan from the local cache; it never calls the model. If the user wants the freshest data and network is available, `ha_news_scan {force: true}`; otherwise say the knowledge is as of the last fetch.
2. `ha_news_digest {window_days: 7, synthesize: false}` for the deterministic compact summary (new Core/frontend/Supervisor releases, extracted breaking-change headings, new integrations, store changes). Use `synthesize: true` only if the user asks for a narrative; it is allowed one model call.
3. Relay only what matters to this house: releases and breaking changes that touch installed integrations/apps, or new functionality matching the user's interests. Cite each item with its source URL and date.
4. If a new release is relevant, offer the compatibility check (`ha_compat_scan {target: {kind: "core", version}}`) and hand the actual update to the app-builder skill. Never update from this playbook.
5. "Nothing new since <date>" is a valid, useful answer — do not manufacture news.

## Playbook G — compatibility before an update

1. `sup_get_updates` — which Core/OS/app updates exist.
2. `ha_compat_scan {upcoming: true}` — deterministic findings for those targets: severity, affected integration/entities/automations, evidence URL.
3. Present the findings in one line each (max 5) next to the update plan bullets; `breaking` findings must be acknowledged by the user before the update proceeds. The user still decides — you never block silently.
4. If the knowledge is stale, say so; offer `ha_news_scan` and re-run the scan.
5. After the update (handled in the builder skill), re-run the scan to confirm the findings are resolved.

## Guardrails

- Monitoring is read-only toward Home Assistant: notifications are its only HA-visible output. No config edits, service calls, restarts, or app changes from a probe or digest.
- Never report a count without its baseline ("23 unavailable" is meaningless without yesterday's number).
- Deduplicate: do not notify the same finding within the cooldown (6 h) unless severity rises; do not repeat user-handled findings.
- Quiet hours: severity ≤2 waits for the digest; severity 3 waits until morning unless it persists >4 h; severity 4 notifies immediately (§5.3).
- Max 3 notifications per target per hour; aggregate beyond that into one message.
- Distinguish measured facts from heuristics; phrase heuristics as questions ("this automation hasn't run in 5 days — is that expected?").
- Do not change the user's notify target, quiet hours, or thresholds without explicit agreement; these are onboarding questions, not guesses.
- If the monitor itself is failing (probe errors, scheduler stale), say so — silent monitoring is worse than no monitoring.
- Knowledge is cache-first: read excerpts, not pages; cite URL + fetched date; label stale knowledge; never present a cached release note as current. Never send HA internals, entity names, or the user's URL/IP to any web service; only public integration/app names may leave the house.
- Compatibility findings are advisory evidence, not verdicts: a `breaking` finding requires the user's acknowledgement before an update, and it never authorizes an automatic YAML fix.

## Worked examples

**1. "Is everything OK?" after a storm**

- `monitor_probe {deep: true}` returns: 14 entities unavailable (baseline 2), all `shelly` platform; `core.reachable` ok; error log has `Error fetching ... Timeout`; disk 21% free; backup 1 day old.
- Answer: "Mostly — 14 Shelly devices are offline, which looks like the same network drop, not a HA problem. Everything else is fine; backup is from yesterday. Want me to check one device or wait 10 minutes and re-probe?" Confidence high for the pattern, medium for the cause. Do not restart anything.

**2. Digest with a backup warning**

- Probe: newest backup 9 days old, `days_until_stale: 30`, automatic backups off, disk free 41 GB; 1 new repair (deprecated integration).
- Digest: one `serious` (backup age, with the offer), one `warning` (repair). After the user says yes: `sup_backup_create {mode: "full", name: "dsh-manual-20261111-0805", background: true}`, poll the job, verify, record. Then propose the repair follow-up separately — not in the same bullet.

**3. "Stop telling me about the kitchen sensor"**

- The user is not asking to hide a problem; they are asking to stop duplicate notifications. `monitor_configure` to add the entity to a suppression list (or raise that check's threshold), then `memory_update` `add_quirk`/`preference`: "kitchen_motion expected to drop during microwave use; suppress separate alerts, keep it in the digest." Explain that the digest will still mention it.
