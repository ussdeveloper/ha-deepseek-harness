# DeepSeek Harness for Home Assistant

An AI agent that lives inside your Home Assistant installation. It can read and
change your configuration, watch the health of your home, keep backups, and help
you build new apps (add-ons) — always with stability and safety first.

> **Developer preview.** Start with `read_only` enabled if you want to evaluate
> it before letting it change anything. The add-on can manage apps and edit your
> configuration; the safety layer is designed for that, but you stay responsible
> for reviewing plans that affect physical safety.

## Install

1. Add the repository in **Settings → Add-ons → Add-on Store → ⋮ → Repositories**:
   `https://github.com/ussdeveloper/ha-deepseek-harness`
2. Install **DeepSeek Harness**, set your DeepSeek API key in **Configuration**
   (or enter it in the app on first run) and start it.
3. Open it from the sidebar.

## What it can do

- **Chat with an agent that knows your home.** The DSH Web UI appears in the
  sidebar, authenticated by your Home Assistant session; no extra port or login.
- **Configure safely.** YAML edits are snapshotted, written atomically and
  validated with the Home Assistant config check before any reload or restart.
- **Monitor.** Every 15 minutes it checks entity availability, error log
  signatures, backups, updates, disk and app health; it sends a daily digest and
  alerts about material problems.
- **Remember.** It keeps a persistent inventory of your installation plus notes
  about quirks, preferences and past changes in `/data/memory`.
- **Manage backups.** It verifies backup age, creates backups before risky
  operations and records a backup ledger.
- **Build apps.** It scaffolds, validates, builds and debugs local apps in
  `/addons`.
- **Keep up with Home Assistant.** Release notes and ecosystem news are fetched
  and indexed locally, so it can warn about breaking changes and recommend
  fitting integrations — without spending model tokens on fetching.

## Options

| Option | Default | Meaning |
|---|---|---|
| `deepseek_api_key` | — | DeepSeek API key (optional; can be set in the UI) |
| `base_url` | `https://api.deepseek.com` | OpenAI-compatible endpoint |
| `read_only` | `false` | Disable every tool that changes Home Assistant |
| `full_access` | `true` | DSH runs in danger-full-access inside the container; `read_only` still wins |
| `allow_restarts` | `false` | Allow Home Assistant restarts after confirmation |
| `allow_addon_management` | `false` | Allow app install/update/rebuild/uninstall after confirmation |
| `monitor_enabled` | `true` | Health checks, digest, backup-age alerts |
| `first_run_analysis` | `true` | One read-only model assessment on the first start (the deterministic report is always written) |
| `notify_service` | — | e.g. `notify.mobile_app_phone`; empty = persistent notifications |
| `backup_retention` | `7` | Automatic backups to keep (1–90) |
| `quiet_hours` | — | `HH:MM-HH:MM` window for non-critical notifications |
| `public_url` | — | Optional fixed external HA URL for generated links |

Changing an option restarts the add-on. Your `/data` (sessions, memory,
settings) is preserved.

## Safety

- A managed safety-first system prompt is part of every session and outranks task
  completion. It cannot be relaxed from chat.
- Destructive actions require a per-action confirmation token: the agent
  prepares the action, explains the impact, and executes only after you confirm.
- Capability options (`read_only`, `allow_restarts`, `allow_addon_management`)
  gate whole tool groups.
- No `host_network`, no Docker socket, no privileged mode; the ingress port is
  not published.

## Data

`/data/dsh-home` (settings, sessions), `/data/memory` (agent memory),
`/data/monitor`, `/data/knowledge`, `/data/config-backups`. `/config` and
`/addons` are your mapped folders. `/data` is included in add-on backups (cold
mode); backups contain your API key, so treat them as secrets.

## Limitations (v0.1)

- Home Assistant OS / Supervised only (needs the Supervisor and ingress).
- The first install builds the image on your device; a Raspberry Pi can take
  several minutes.
- Model selection happens in the app on first run.
- No AppArmor profile yet.

## Troubleshooting

- **Panel missing**: your HA user must be an administrator.
- **"starting; retry in a moment"**: wait ~30 s after add-on start.
- **401/403 from the model API**: set the API key in the app's model settings.
- **A tool is missing**: it is disabled by an option or by read-only mode; check
  the add-on log for `[ha-deepseek-harness] registered N tools`.

