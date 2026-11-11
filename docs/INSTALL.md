# Installation & configuration

## Requirements

- Home Assistant **OS** (Supervisor present). HA Supervised works too; HA
  Container is not supported in v0.1.
- amd64 or aarch64 hardware, ~1 GB free RAM, ~1.5 GB free disk for the image.
- A DeepSeek API key (or another OpenAI-compatible endpoint) — you can also
  enter it later in the UI.
- Internet access from the add-on for the LLM API (and optional release-news
  fetching). Everything else runs locally.

## Install

1. **Settings → Add-ons → Add-on Store → ⋮ → Repositories**
2. Add: `https://github.com/ussdeveloper/ha-deepseek-harness`
3. Install **DeepSeek Harness**. On HA OS the image is built on the device the
   first time (a few minutes on a Raspberry Pi).
4. Open the **Configuration** tab:
   - `deepseek_api_key` — your key (optional; can be entered in the UI instead)
   - `base_url` — leave default unless you use a proxy/self-hosted gateway
   - `read_only` — start here if you only want advice and monitoring
   - `allow_restarts`, `allow_addon_management` — off by default
   - `monitor_enabled` — health checks, digest and backup-age alerts
   - `first_run_analysis` — one read-only model assessment on the first start
     (deterministic inventory report is always written)
   - `notify_service` — e.g. `notify.mobile_app_your_phone`
   - `backup_retention`, `quiet_hours`, `public_url` — optional
5. **Start** the add-on, then click **Open Web UI** (or the sidebar entry).
6. First run: choose the model (`deepseek-chat` recommended) and enter the API
   key in the DSH onboarding UI if you did not put it in the options. Settings
   are stored in `/data` and survive restarts and updates.

## What you get

- **DeepSeek Harness Web UI** in the sidebar, authenticated by your Home
  Assistant session. The DSH port is never published; there is no second login.
- **Home Assistant tools**: states, services, history, logs, config check,
  template rendering, automation overview, WebSocket diagnostics (registry,
  repairs, system log, traces).
- **Supervisor tools**: versions/health, updates, apps (add-ons), store, jobs,
  backups; app lifecycle is gated by the `allow_addon_management` option and
  explicit confirmation.
- **Safe configuration editing**: snapshots, atomic writes, SHA-256
  read-before-write, YAML/HASS config check, automatic rollback on invalid
  config.
- **Memory**: a deterministic inventory of your installation plus curated notes
  about your home, quirks and past changes (`/data/memory`).
- **Monitoring**: 15-minute health probe, deduplicated findings, daily digest,
  stale-backup alerts, update awareness — no LLM calls in the collection path.
- **Backup stewardship**: verifies backup age, creates Supervisor backups on
  request and before risky operations, keeps a ledger.
- **Local knowledge**: release notes / ecosystem news fetched and indexed locally
  (`/data/knowledge`), searched without spending model tokens.
- **Add-on builder**: scaffold, validate, build and debug local apps in
  `/addons`.

## Data & backups

- `/data/dsh-home` — DSH configuration, credentials, sessions, settings.
- `/data/memory` — agent memory and change history.
- `/data/monitor` — monitoring state and findings.
- `/data/knowledge` — local knowledge cache/index.
- `/data/config-backups` — snapshots taken before config edits.
- `/config/deepseek-harness` — the agent's working directory (scratch files, reports).
- `/config` and `/addons` are mapped host folders, not part of the add-on
  backup; `/data` is included in Home Assistant backups.

Backups use `cold` mode: the add-on stops briefly while its data is archived, so
the SQLite session store is consistent. Treat add-on backups as secrets (they
contain the API key).

## Safety model in one minute

1. A managed, safety-first system prompt is part of every session and outranks
   task completion; it cannot be relaxed from chat.
2. Destructive tools require a per-action confirmation token: prepare → user
   confirms → execute. Tokens expire after 5 minutes and are bound to the exact
   arguments.
3. Configuration changes go through snapshot → atomic write → config check →
   rollback on failure.
4. `read_only`, `allow_restarts` and `allow_addon_management` options gate whole
   capability groups.
5. Secrets are never sent to the model: `secrets.yaml` values, `.storage`,
   tokens and other apps' options are excluded by the tools.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Sidebar entry missing | Your user must be an administrator (`panel_admin: true`). |
| "DeepSeek Harness is starting; retry" | Wait ~30 s after start; check the add-on log. |
| Blank page / 401/403 in UI | Reload the panel; check the log for the captured launch token line. |
| No models / 401 from API | Set the API key in the DSH UI (Settings → Models) or add-on options, then restart. |
| Tools missing | Check `read_only` and the add-on log for `[ha-deepseek-harness] registered N tools`. |
| Config edit rejected `STALE_BASE` | The file changed after reading; re-read and retry. |
| Approval token rejected | Ask the agent again; tokens are single-use and expire in 5 minutes. |
| Add-on build fails | The agent reads Supervisor + app logs; you can also check **Settings → Logs**. |

## Uninstall

Removing the add-on keeps `/data` until you choose to delete it. To reset the
agent, remove the add-on with its data, or delete `/data/memory` and
`/data/dsh-home` from a terminal add-on. Always take a Home Assistant backup
first.

## Known limitations (v0.1)

- HA Container installations are not supported (no Supervisor/ingress).
- Model selection happens in the UI on first run; the add-on option exists only
  for the base URL.
- Add-on management assumes local builds (no prebuilt image yet), so the first
  install compiles on the device.
- No AppArmor profile yet; the container is confined by Home Assistant's docker
  isolation, no privileged flags and no host access.
- Some diagnostics rely on undocumented WebSocket commands and degrade to
  `UNSUPPORTED` on incompatible HA versions.


