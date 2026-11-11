# Persistent memory

The add-on gives the agent a durable memory of the installation so the user does
not have to repeat context in every conversation, and so the agent can answer
"what changed?", "which backup predates the breakage?", "what did you try last
time?". Memory lives in `/data/memory`, is included in add-on backups, and is
written only by the add-on.

## Files

```
/data/memory/
├── system.json     structured memory: collected inventory + curated notes
├── system.md       human-readable summary (safe to read and show to the user)
├── changelog.jsonl append-only durable-change audit trail (rotates at 2 MB)
├── backups.json    backup ledger: created / verified / restored / pruned
└── baselines.json  monitor baselines, dedupe and quiet-hours state
```

Writes are atomic (temp file + rename, mode 0600). `system.md` never contains
secrets and never dumps raw states.

## Two ownership domains

| Domain | Written by | Contents |
|---|---|---|
| `collected` | deterministic collector only, no LLM | versions, host/disk, integrations, entity counts, unavailable entities, automations, apps, updates, backups, config-file hashes |
| `curated` | the agent via `memory_update` | preferences, hardware notes, quirks, incidents, intent, do-not-touch list, open tasks, backup policy |

A refresh never silently overwrites curated notes. When live data contradicts a
curated fact, the live data wins and the stale note is marked `verify`.

## Collection

The background collector refreshes the deterministic snapshot every 15 minutes
and on demand (`memory_refresh`) using read-only API calls:

- `GET /api/config`, `/api/states` → version, components, entity/domain counts,
  unavailable entities, automation `last_triggered` staleness.
- Supervisor `/info`, `/core/info`, `/os/info`, `/supervisor/info`, `/host/info`
  → versions, channel, health, disk, machine.
- `GET /addons` → apps, versions, update availability, state.
- `GET /available_updates` → pending updates.
- `GET /backups/info` + ledger → newest backup, age, `days_until_stale`.
- config directory listing → file inventory with SHA-256 (secrets are hashed,
  never read).

The snapshot targets < 128 KB and is idempotent; failures keep the previous
snapshot and mark sections stale.

## Curated notes

Buckets: `preferences`, `hardware`, `quirks`, `incidents`, `intent`,
`do_not_touch`, `open_tasks`, `backup_policy`. Bounds: 32 KB and 200 entries
total. `memory_update` supports `set`, `append`, `add_quirk`, `resolve_quirk`,
`record_change`, `record_backup`; it refuses to edit `collected` and uses
optimistic concurrency (`base_revision`).

## Update policy

- **Refresh** at app start, first probe of the day, after HA/update changes,
  after mutating tool calls, and before any disruptive plan.
- **Curate** after a successful change (`record_change` with what/why/tool and
  the snapshot/backup id), after a diagnosis that found a durable quirk, when the
  user states a preference or a "do not touch" item, and when a recorded quirk is
  verified gone.
- **Never store** secrets, tokens, app option values, full state dumps, camera
  snapshots, or personal data the user did not volunteer.

## Survival and recovery

- `/data` survives add-on restarts and updates; memory is included in full Home
  Assistant backups (the add-on uses `cold` backup mode, so the SQLite session
  store is consistent).
- After a full restore, memory may describe a newer system: the first action is
  `memory_refresh` plus a `record_change` entry recording the restore.
- Removing the add-on with data deletes memory; export `system.md`/`system.json`
  first if it matters.

## Backups

Backups are a first-class memory concern:

- A Supervisor backup is created before core/app updates, uninstalls, restores
  and structural config changes (or the tool refuses with `NEEDS_APPROVAL` and a
  hint to create one first).
- Weekly scheduled backup when monitoring is enabled.
- Each backup is verified via `/backups/<slug>/info`; failures are not silently
  ignored.
- Retention comes from `backup_retention` (default 7); the newest good backup and
  user-created backups are never pruned by the agent.
