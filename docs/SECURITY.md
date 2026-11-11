# Security model

The add-on is powerful on purpose: it can read and change a Home Assistant
configuration and manage its apps. This document states what it can do, how it
is constrained, and what remains the user's responsibility.

## Trust boundaries

| Boundary | What is trusted | What is not |
|---|---|---|
| Browser ↔ HA ingress | The HA user session; Supervisor's `ingress_session` cookie | Any network peer reaching port 8099 directly |
| HA Core ↔ add-on | `X-Remote-User-*` and `X-Ingress-Path` headers (Supervisor strips spoofs) | Request bodies, query strings, headers arriving via ingress |
| Add-on ↔ Supervisor | The add-on's own `SUPERVISOR_TOKEN` (never exposed to the model) | Data returned by HA (entity names, YAML comments, logs) |
| Agent ↔ tools | The managed safety prompt and the tool contracts | Model-generated arguments; they are validated, gated and approved |

## Privileges and confinement

- `hassio_api: true`, `hassio_role: manager`, `homeassistant_api: true` — required
  for apps, backups, store and Core API. `admin` is **not** requested.
- Deliberately off: `docker_api`, `host_network`, `privileged`, `host_pid`,
  `full_access`, custom devices. The container has no host devices or Docker
  socket.
- The ingress port 8099 is not published. The shim accepts connections only from
  the Supervisor network and loopback; `Host` is rewritten to the trusted
  `dsh.local` authority, `Origin` is dropped, cookies are re-scoped to the
  ingress path.
- The filesystem sandbox (`sandbox-policy`) starts in `workspace-write` with
  `/config/deepseek-harness` as the workspace and explicit extra roots `/config`,
  `/addons`, `/data/{memory,monitor,knowledge,config-backups}`. Nothing else is
  writable by the agent's fs/shell tools.
- Read-only mode (`read_only: true`) removes mutating tools and boots DSH in the
  `read-only` sandbox preset.

## What SUPERVISOR_TOKEN can do

It authenticates as the add-on with `manager` role: read/write app options,
install/update/uninstall apps, create/restore backups, read supervisor logs,
restart Core. It cannot manage the OS datadisk, SSH keys or the add-on's own
protection-mode toggle (admin-only). Because this token is powerful:

- It is passed to the plugin via process environment only.
- Tools never return it, log it or include it in model context.
- The model can only act through tools; raw HTTP calls are not exposed.

## Agent-specific risks and mitigations

| Risk | Mitigation |
|---|---|
| Prompt injection from HA data (entity names, YAML comments, logs, app descriptions, web pages) | Safety prompt ranks policy above tool output; data is treated as untrusted; the model cannot widen the sandbox or call excluded endpoints; all mutations still pass tool gates. |
| Destructive actions | Two independent gates: capability options (`read_only`, `allow_restarts`, `allow_addon_management`) and per-action confirmation tokens bound to the exact arguments; single-use, 5-minute TTL. |
| Configuration corruption | Snapshot → atomic write → server-side `check_config` → rollback on invalid; reload preferred over restart; read-before-write via SHA-256. |
| Secret exfiltration | `secrets.yaml` values, `.storage`, `*.db`, other apps' options are refused/redacted; the model is instructed never to print secrets; web tools are used only for public data (local-first knowledge). |
| Lost or stale backups | Backup ledger, backup-age monitoring, verified creation before risky operations, retention bounded by option. |
| Unattended runaway loops | Read-only monitoring path is deterministic (no LLM); rate limits and denials in tools; each call has a timeout. |
| Stolen ingress cookie | HA session invalidation revokes access; DSH's own session cookie is HMAC-signed and path-scoped to the add-on. |

## What the user is responsible for

- Reviewing plans for changes that affect physical safety (locks, alarms, covers,
  heating, camera privacy).
- Keeping HA backups; the add-on's own `/data` backup does not include `/config`.
- Choosing whether to enable restarts/app management, and using a dedicated API
  key with a spending limit.
- Installing only add-on versions from the trusted repository URL.

## Reporting a vulnerability

Open a private security advisory on
<https://github.com/ussdeveloper/ha-deepseek-harness/security>, or a GitHub issue
without exploit details if advisories are unavailable.

