# Packaging DeepSeek Harness as a Home Assistant add-on — verified spec

| | |
|---|---|
| Author | `ha-addon-researcher` (task-1) |
| Date | 2026-11-11 |
| Status | Research complete; no real HA instance was available. Every claim below is cited; items that could not be confirmed are marked **UNVERIFIED**. |
| Deliverable repo | https://github.com/ussdeveloper/ha-deepseek-harness (account `ussdeveloper`), used as an **add-on repository URL** in HA OS. |
| Scope | `config.yaml` manifest, `map`, Supervisor API, ingress, local build/install loop, distribution, security, proposed manifest + `run.sh`. |
| Out of scope | DSH's own container/CLI/plugin mechanics — see `docs/research/dsh-container.md` (teammate `dsh-container-researcher`). |

## Source of truth / terminology note

The official developer docs moved on 2026 and now call add-ons **apps**: `https://developers.home-assistant.io/docs/add-ons/...` redirects to `https://contributors.home-assistant.io/apps/...` (observed: this fetch returned a cross-origin redirect to `contributors.home-assistant.io`). The **file name `config.yaml` and the Supervisor API paths (`/addons`, `/store/addons`) did not change**:

> "The paths still use the old name: apps live under `/addons` and `/store/addons`. That is the real API, so that is what you call."
> — https://contributors.home-assistant.io/apps/supervisor-api/

This document uses "add-on"/"app" interchangeably, but always the real `config.yaml` keys and `/addons` API paths.

**Primary sources used**

- Configuration reference: https://contributors.home-assistant.io/apps/reference/configuration/
- How add-ons work: https://contributors.home-assistant.io/apps/how-apps-work/
- Runtime environment: https://contributors.home-assistant.io/apps/reference/environment/
- Files in an add-on folder: https://contributors.home-assistant.io/apps/reference/files/
- Options/schema: https://contributors.home-assistant.io/apps/guides/options/
- Ingress: https://contributors.home-assistant.io/apps/guides/ingress/
- Communication (Supervisor + Core API): https://contributors.home-assistant.io/apps/guides/communication/
- Security: https://contributors.home-assistant.io/apps/guides/security/
- Security rating: https://contributors.home-assistant.io/apps/reference/security-rating/
- Dockerfile/base images: https://contributors.home-assistant.io/apps/guides/dockerfile/
- S6 overlay: https://contributors.home-assistant.io/apps/guides/s6-overlay/
- Testing: https://contributors.home-assistant.io/apps/guides/testing/
- Publishing: https://contributors.home-assistant.io/apps/guides/publishing/
- Repository: https://contributors.home-assistant.io/apps/guides/repository/
- Presentation (icon/logo): https://contributors.home-assistant.io/apps/guides/presentation/
- Supervisor API overview: https://contributors.home-assistant.io/apps/supervisor-api/
- Supervisor API: apps / store / core / supervisor / services: `.../apps/supervisor-api/{apps,store,core,supervisor,services}/`
- Bashio apps functions: https://contributors.home-assistant.io/apps/bashio/apps/
- Supervisor source (validated against `main`, fetched 2026-11-11):
  - `supervisor/apps/validate.py` — https://github.com/home-assistant/supervisor/blob/main/supervisor/apps/validate.py
  - `supervisor/apps/const.py` — https://github.com/home-assistant/supervisor/blob/main/supervisor/apps/const.py
  - `supervisor/apps/app.py` — https://github.com/home-assistant/supervisor/blob/main/supervisor/apps/app.py
  - `supervisor/apps/manager.py` — https://github.com/home-assistant/supervisor/blob/main/supervisor/apps/manager.py
  - `supervisor/docker/app.py` — https://github.com/home-assistant/supervisor/blob/main/supervisor/docker/app.py
  - `supervisor/docker/const.py` — https://github.com/home-assistant/supervisor/blob/main/supervisor/docker/const.py
  - `supervisor/api/__init__.py` — https://github.com/home-assistant/supervisor/blob/main/supervisor/api/__init__.py
  - `supervisor/api/ingress.py` — https://github.com/home-assistant/supervisor/blob/main/supervisor/api/ingress.py
  - `supervisor/api/const.py` — https://github.com/home-assistant/supervisor/blob/main/supervisor/api/const.py
  - `supervisor/const.py` — https://github.com/home-assistant/supervisor/blob/main/supervisor/const.py
- HA Core ingress proxy: https://github.com/home-assistant/core/blob/master/homeassistant/components/hassio/ingress.py
- DSH (local read-only checkout `upstream-dsh`): `packages/bundle/web-app/src/startup.ts`, `packages/bundle/web-app/README.md`, `docs/user/guide/public-deployments.md`, `apps/cli/README.md`.

---

# 1. Manifest: `config.yaml` fields we need

Canonical reference: https://contributors.home-assistant.io/apps/reference/configuration/ (page follows the schema in `supervisor/apps/validate.py`). Unknown keys are **silently ignored** (`extra=vol.REMOVE_EXTRA` in `_SCHEMA_APP_CONFIG`, validate.py), so a typo does not error — it silently does nothing.

## 1.1 Required keys

| Key | Our value | Notes / source |
|---|---|---|
| `name` | `"DeepSeek Harness"` | App store name. |
| `version` | `"0.1.0"` (quoted) | Must be quoted so YAML does not parse `1.10` as float. Also the image tag when `image` is used, and the update-comparison value. |
| `slug` | `"deepseek_harness"` | Letters/digits/`-_.`; unique in repository. Installed ID becomes `local_deepseek_harness` for local apps, or `{repo_id}_deepseek_harness` when installed from a repository URL. https://contributors.home-assistant.io/apps/how-apps-work/#names-and-ids |
| `description` | `"DeepSeek Harness agent Web UI with Home Assistant access"` | App store text. |
| `arch` | `[aarch64, amd64]` | `armhf`/`armv7`/`i386` accepted but deprecated with a warning. |

## 1.2 Behaviour / information keys (all requested keys resolved)

| Key | Valid values / default | What it does | Our choice |
|---|---|---|---|
| `url` | URL | Homepage shown on app page. | `https://github.com/ussdeveloper/ha-deepseek-harness` |
| `image` | image name **without tag** | Prebuilt image; Supervisor pulls tag `version`. Without `image`, the Supervisor builds from `Dockerfile` on the device. | **Omit for v1 local-build**; set to `ghcr.io/ussdeveloper/ha-deepseek-harness` when publishing (see §7). |
| `startup` | `initialize` \| `system` \| `services` \| `application` (default) \| `once` | Boot-stage ordering. **`start` is not a valid key** — the key is `startup`. | `application` (default). |
| `boot` | `auto` (default) \| `manual` \| `manual_only` | Default "Start on boot" state. | `auto` |
| `init` | bool, default `true` | Docker init. HA base images use S6 overlay and need `false`. | `false` |
| `hostname` | **NOT A KEY** | Container hostname is derived from the app ID (`_`→`-`, e.g. `local-deepseek-harness`) unless `host_uts: true`. `docker/app.py` `run()`: `hostname = None if uts_mode else self.app.hostname`. | do not set |
| `options` / `schema` | mappings | Defaults + validated option types, written to `/data/options.json` before every start. https://contributors.home-assistant.io/apps/guides/options/ | see §8.2 |
| `ports` | `"<container>/tcp": <host>` | Host port mapping. `null` = off by default. | **not set** (ingress only) |
| `ports_description` | mapping per port | Descriptions; prefer translations. | not needed |
| `ingress` | bool, default `false` | Sidebar web UI through HA authentication. | `true` |
| `ingress_port` | int, default `8099`; `0` = Supervisor picks 62000–65500 | Port our server listens on inside the container. | `8099` |
| `ingress_entry` | string path | Start path of the app if not `/`. Leave it out when the start page is `/`: with an entry the Supervisor appends it to `ingress_url` (`/api/hassio_ingress/<token>/`), so `"/"` would yield a double slash (`apps/app.py` `ingress_url`). | **omit** (default `/`) |
| `ingress_stream` | bool, default `false` | Stream POST bodies instead of buffering. Needed for large uploads. | `true` if DSH uploads >16 MiB (verify; POST-only, source: `api/ingress.py`) |
| `panel_icon` | MDI name, default `mdi:puzzle` | Sidebar icon. | `mdi:robot-happy-outline` (any existing MDI name) |
| `panel_title` | string, default app name | Sidebar title. | `"DeepSeek Harness"` |
| `panel_admin` | bool, default `true` | Only show in admin sidebars **and enforced: Supervisor returns HTTP 403 to non-admin ingress sessions** (`api/ingress.py`: `if app.panel_admin and (user is None or not user.is_admin): raise HTTPForbidden`). | `true` for v1 |
| `hassio_api` | bool, default `false` | Access to Supervisor API beyond self/info endpoints, limited by `hassio_role`. | `true` |
| `hassio_role` | `default` (default) \| `homeassistant` \| `backup` \| `manager` \| `admin` | Role for Supervisor API. | `manager` (see §8) |
| `homeassistant_api` | bool, default `false` | Proxy to HA Core REST + WebSocket API at `http://supervisor/core/api`; **acts as HA administrator**. | `true` |
| `docker_api` | bool, default `false` | Mounts `/run/docker.sock` read-only; only works with protection mode off; rating drops to 1. **Not needed** — Supervisor builds images itself. | omit/false |
| `host_network` | bool, default `false` | Host network. | `false` |
| `privileged` | list of capabilities | Extra caps (`SYS_ADMIN`, `NET_ADMIN`, ...). Only ask what is needed. | not set |
| `apparmor` | bool, default `true`; add `apparmor.txt` for a custom profile | +1 security rating if a custom profile loads. | `true` + custom `apparmor.txt` (later) |
| `map` | list of `{type, read_only, path}` | Host folders mounted into the container. | see §2 |
| `watchdog` | URL template | Liveness probe; **there is no `healthcheck:` manifest key**. Probe: `tcp://[HOST]:[PORT:x]` = port check, `http(s)://[HOST]:[PORT:x]/path` = any status < 300 is healthy (`apps/app.py` `watchdog_application`). | `tcp://[HOST]:[PORT:8099]` |
| `environment` | mapping string→string | Extra env vars. Keys matched `\w*`. | `DSH_HOME`, `NODE_ENV`, ... |
| `stage` | `stable` (default) \| `experimental` \| `deprecated` | Lifecycle label. | `experimental` |
| `backup` | `hot` (default) \| `cold` | Hot = app keeps running during backup; cold = stopped. `/data` and (`app_config` folder) are in the backup. | `cold` for v1 (SQLite/session DB consistency; see §6.4) |
| `backup_exclude` | list of glob patterns | Files under `/data` to omit. Patterns are matched against the **full path as the Supervisor sees it** (`app.py` `_is_excluded_by_filter`, `Path.match`). Use simple patterns (`*.log`, `cache/*`), not complex `**` globs (Python `Path.match` `**` is not a recursive glob — **UNVERIFIED** for our edge cases). | `["*.log", "tmp/*", "cache/*"]` |
| `backup_pre` / `backup_post` | command string run inside container | For hot backups only (ignored with `cold`). | not needed with `cold` |
| `timeout` | int 10–300, default 10 | Seconds Supervisor waits for a clean stop before SIGKILL. | `30` |
| `advanced` | **deprecated** | "Deprecated since Supervisor 2026.03.0; this field is ignored" (`validate.py` `_warn_app_config`). Do not use. | omit |
| `healthcheck` | **NOT A KEY** | No such manifest key exists. Health comes from (a) the image's Docker `HEALTHCHECK` if present (Supervisor maps container HEALTHY/UNHEALTHY to app `STARTED`/`UNHEALTHY`, `apps/app.py` `_derive_state`; `start()` docstring: "For apps with a healthcheck, that is when they become healthy or unhealthy") and (b) the `watchdog` URL probe. | no `HEALTHCHECK` in v1; use `watchdog` |

Other keys accepted but not needed: `machine`, `homeassistant` (minimum Core version), `breaking_versions`, `auth_api`, `stdin`, `legacy`, `services`, `discovery`, `tmpfs`, `host_pid`, `host_ipc`, `host_uts`, `host_dbus`, `journald`, `realtime`, `ulimits`, `devices`, `uart`, `usb`, `gpio`, `udev`, `devicetree`, `video`, `audio`, `kernel_modules`, `full_access`, `log_format`, `supervisor_api_tcp` (undocumented; see §1.4).

## 1.3 Which flag/role is needed for what

From https://contributors.home-assistant.io/apps/guides/security/#api-roles and https://contributors.home-assistant.io/apps/supervisor-api/:

| Capability | Needs |
|---|---|
| Own status, options, start/stop/restart, logs one level deep (`/addons/self/...`) | **no** `hassio_api` |
| `GET /info`, `/services`, `/discovery`, `/auth` (`auth_api: true`) | no `hassio_api` |
| Every `*/info` endpoint (`/core/info`, `/host/info`, `/addons/<app>/info`) | `hassio_api: true` + any role (incl. `default`) |
| `/addons` list, other apps' start/stop/restart/options/logs, `/store`, `/store/reload`, `/store/addons/*/install`, `/addons/reload`, `/backups`, `/core/restart`, `/core/stop`, `/core/start`, `/core/update`, `/host/*`, `/os/*` (except wipe), `/jobs`, `/network`, `/resolution`, `/security` | `hassio_api: true` + `manager` |
| Toggle protection mode (`POST /addons/<app>/security`) incl. for `self`; wipe data disk; host SSH keys | **`admin`** (manager is not enough) |
| HA REST/WebSocket proxy `/core/api/*`, `/core/websocket` | `homeassistant_api: true` (any role; admin-level on HA side) |
| `/ingress/panels` | `hassio_api: true` + `admin` |
| Nothing (always) | `GET /supervisor/ping` |

Security rating impact (https://contributors.home-assistant.io/apps/reference/security-rating/): `ingress: true` +2, custom AppArmor profile +1, `hassio_role: manager` −1, `admin` −2, `host_network` −1, `docker_api`/`full_access` ⇒ rating 1. Our proposed manifest scores 5 +2 (+1 later with profile) −1 = 6/8 initially, 7/8 with AppArmor.

## 1.4 Two compatibility notes

1. **`supervisor_api_tcp` / token delivery.** `Supervisor` injects `SUPERVISOR_TOKEN`/`HASSIO_TOKEN` only when the per-app `supervisor_api_tcp` is true; otherwise it injects `SUPERVISOR_SOCKET` pointing at a per-app socket (`docker/app.py` `environment`, `docker/const.py` `ENV_SUPERVISOR_SOCKET`). `const.py` contains the comment "Flipped to False late in the deprecation cycle, before the TCP API is removed". The key exists in `validate.py` but is **not documented** on the config reference. **UNVERIFIED**: what official add-on tooling will use once the TCP API is off; don't set `supervisor_api_tcp` (leave the current default) and assume `http://supervisor/` + `SUPERVISOR_TOKEN` as documented today.
2. **`image` and backup size.** When an add-on is built locally (`need_build`), its **image is exported into every backup** (`apps/app.py` `backup()` → `if self.need_build: await self.instance.export_image(...)`; `restore()` imports it back). A locally built Node/DSH image can be hundreds of MB, so users' backups get huge. This is the main practical argument for publishing a prebuilt multi-arch image before shipping to users (§7).

---

# 2. `map`: the exact set, and the /addons question

## 2.1 Current map types

`MappingType` in `supervisor/apps/const.py` (**current**, non-deprecated):

| Type | Mounted at (container) | Host folder |
|---|---|---|
| `data` | `/data` | app's private data (always mounted; only use it to change `path`) |
| `homeassistant_config` | `/homeassistant` (override with `path`) | Home Assistant `/config` |
| `app_config` | `/config` | this app's public config folder (in backups) |
| `all_app_configs` | `/app_configs` | all apps' public config folders |
| `local_apps` | `/local_apps` (override with `path`) | the host **local add-ons** folder |
| `ssl` | `/ssl` | certificates |
| `backup` | `/backup` | backups |
| `share` | `/share` | shared files |
| `media` | `/media` | media |

Deprecated aliases (still parsed, log a warning, "deprecated as of 2026.07; use app equivalents" — `apps/const.py`):

| Legacy type | Modern replacement | Legacy mount |
|---|---|---|
| `addons` | `local_apps` | `/addons` |
| `all_addon_configs` | `all_app_configs` | `/addon_configs` |
| `addon_config` | `app_config` | `/config` |
| `config` | `homeassistant_config` | `/config` (Home Assistant config; **ignored** if `app_config`/`addon_config`/`homeassistant_config` is also present — `validate.py` `_migrate_app_config`) |

Entry form: mapping with `type` (required), `read_only` (default **true**), `path` (optional mount point override). Old short strings (`share:rw`, `addons:rw`) still parse via `RE_VOLUME` in `validate.py` but log a deprecation warning. Sources: https://contributors.home-assistant.io/apps/reference/configuration/#folders , https://contributors.home-assistant.io/apps/reference/environment/#folders , `supervisor/docker/app.py` `mounts` (every type honours `path` as target), `supervisor/docker/const.py` `PATH_*`.

## 2.2 CRITICAL: does `addons:rw` exist and mount the local add-ons dir at `/addons`?

- **Yes, it still exists** — `MappingType.ADDONS = "addons"` and `RE_VOLUME` includes `addons`, and `docker/app.py` mounts it at `PATH_LOCAL_ADDONS = /addons`. But it is **deprecated** in favour of `local_apps` and logs a warning on every store reload (`validate.py` `_warn_app_config`: "App '…' uses legacy map type 'addons'; use 'local_apps' instead.").
- **Supported alternative:** use the modern type and put it back at `/addons` with `path`:

```yaml
map:
  - type: local_apps
    read_only: false
    path: /addons          # optional: keep tooling paths stable
```

`read_only` defaults to **true**, so `read_only: false` is required for scaffolding new local add-ons. Source: `supervisor/docker/app.py` mounts with `read_only=app_mapping[LOCAL_APPS].read_only`, target `path or /local_apps`.

The **host-side location of the local apps folder is abstracted** by the mapping: the Supervisor mounts `sys_config.path_extern_apps_local` (`docker/app.py`). The legacy backup folder name `addons/local` and the newer `apps/local` folder enum (`supervisor/const.py` `Folder.APPS`) show that HA OS itself is renaming this share; the mapped path inside our container is the stable interface. Do not hard-code a host path.

For the Lead's `/config` requirement: mount **Home Assistant config** at `/config` using the modern type plus a path override (source-confirmed allowed) and do **not** map `app_config` (both default to `/config`, and `_migrate_app_config` warns about incompatible combinations):

```yaml
map:
  - type: homeassistant_config
    read_only: false
    path: /config
  - type: local_apps
    read_only: false
    path: /addons
  - type: share
    read_only: true
```

---

# 3. Supervisor API

## 3.1 Base URL and authentication

From inside the add-on container (source: https://contributors.home-assistant.io/apps/supervisor-api/#base-url-and-authentication):

- Base URL: `http://supervisor/` (= `172.30.32.2`; alias `hassio`; `network_mapping` in `docker/app.py`).
- Token: `SUPERVISOR_TOKEN` env var (old alias `HASSIO_TOKEN`). Only visible to scripts started with `#!/command/with-contenv bashio` because S6 keeps the env apart — https://contributors.home-assistant.io/apps/s6-overlay/#the-container-environment
- Accepted auth headers, checked in this order: `X-Supervisor-Token`, `X-Hassio-Key` (legacy), `Authorization: Bearer`.
- **Exception:** `/auth` treats any `Authorization` header as HTTP Basic; send the token in `X-Supervisor-Token` there. Source: https://contributors.home-assistant.io/apps/guides/security/#use-home-assistant-users
- Response envelope: `{"result":"ok","data":...}` / `{"result":"error","message":...,"error_key":...}`; logs/changelogs are plain text; `200/400/401/403/404/409/500` documented. Long operations (`install`, `update`, backup) are **jobs**: pass `background: true` to get `job_id`, poll `GET /jobs/<job_id>`.

## 3.2 Endpoint matrix (requested list, exact methods and minimum privilege)

`<app>` = full slug (`local_deepseek_harness`, `core_mosquitto`, ...) or `self`. Sources: app/store/core/supervisor/services pages under https://contributors.home-assistant.io/apps/supervisor-api/.

| Method | Path | Minimum access | What it returns / notes |
|---|---|---|---|
| GET | `/supervisor/ping` | no token | Supervisor up? |
| GET | `/supervisor/info` | any role + `hassio_api` (also covered by `/info`) | Supervisor version, channel, arch, feature flags |
| GET | `/info` | none | system overview (versions, machine, timezone) |
| GET | `/host/info` | `hassio_api` + any role | host/OS/hardware info |
| GET | `/core/info` | `hassio_api` + any role | Core version, port, ssl, machine |
| POST | `/core/api/<path>` | `homeassistant_api: true` | **proxy** to HA REST `/api/<path>` (GET/POST/DELETE). Not wrapped in Supervisor envelope. |
| GET | `/core/api/states`, `/core/api/services`, `/core/api/config`, `/core/api/error_log` | `homeassistant_api: true` | HA REST endpoints via the proxy (e.g. `GET /core/api/states/sun.sun`) |
| POST | `/core/api/config/core/check_config` | `homeassistant_api: true` | HA REST config check (equivalent Supervisor path is `POST /core/check`) |
| GET | `/core/api/stream` | `homeassistant_api: true` | SSE event stream proxy |
| GET | `/core/websocket` (also `/core/api/websocket`) | `homeassistant_api: true` | HA WebSocket proxy; auth with `{"type":"auth","access_token":"<SUPERVISOR_TOKEN>"}`; `supervisor/`/`hassio/` commands are refused |
| POST | `/core/check` | `hassio_api` + `homeassistant`/`manager`/`admin` | HA config check (Supervisor-native) |
| POST | `/core/restart` | `hassio_api` + `homeassistant`/`manager`/`admin` | restart Core (`safe_mode`, `force` options) |
| GET | `/core/logs` (+`/follow`, `/latest`, `/boots/<id>`) | `hassio_api` + `homeassistant`/`manager`/`admin` | plain-text logs, `lines=`, `verbose`, `no_colors` |
| GET | `/addons` | `hassio_api` + `manager` | installed apps list |
| POST | `/addons/reload` | `hassio_api` + `manager` | alias of `POST /store/reload` |
| GET | `/addons/self/info` | **none** | self details incl. `ingress_url`, `ingress_entry`, `ingress_port`, `ingress_panel`, `ip_address`, `options` (self) |
| GET | `/addons/self/options/config` | **none** | own validated options, defaults filled, `!secret` resolved |
| POST | `/addons/self/options` | **none** | change own options (`bashio::app.option` uses it) |
| POST | `/addons/self/start\|stop\|restart` | **none** (self) | self lifecycle; other apps need `manager` |
| GET | `/addons/<app>/info` | `hassio_api` + any role | details; for non-installed apps falls back to store info with `state: unknown` |
| POST | `/addons/<app>/install` | `hassio_api` + `manager` | **legacy alias** of `POST /store/addons/<app>/install` (still routed; `api/__init__.py`) |
| POST | `/addons/<app>/update` | `hassio_api` + `manager` | legacy alias of store update; **an app cannot update itself** |
| POST | `/addons/<app>/uninstall` | `hassio_api` + `manager` | `remove_config: bool` |
| POST | `/addons/<app>/options` | `manager` for others; **self allowed** | patch options; changes apply at next start |
| POST | `/addons/<app>/security` | **`admin`**, even for `self` | toggle protection mode |
| GET | `/addons/<app>/logs` | `manager` for others; self allowed (one level) | **`/logs/follow` needs `hassio_api`** (deeper path) |
| GET | `/addons/<app>/stats` | `manager` for others; self allowed | CPU/mem/net/blk; `?one_shot` |
| POST | `/store/reload` | `hassio_api` + `manager` | re-read all repositories **and the local apps folder** |
| GET | `/store` | `hassio_api` + `manager` | all store apps + repositories |
| GET | `/store/addons/<app>` | `hassio_api` + `manager` | store details (rating, ingress, hassio flags) |
| POST | `/store/addons/<app>/install` | `hassio_api` + `manager` | build on device (no `image`) or pull; `background: true` |
| POST | `/store/addons/<app>/update` | `hassio_api` + `manager` | `backup: true` makes a partial backup first |
| GET | `/store/repositories` | `hassio_api` + `manager` | repo list; `POST` adds, `POST .../repair` re-clones |
| GET | `/backups` | `hassio_api` + `backup`/`manager`/`admin` | list backups (`/backups/info`, `new/full`, `new/partial`, `{slug}/restore/*`, `reload`, ...) |
| GET | `/ingress/panels` | `hassio_api` + **`admin`** | ingress panels: per slug `{title, icon, admin, enable}` (`api/ingress.py` `panels`) |
| POST | `/ingress/session` | only HA Core | create ingress session (cookie `ingress_session`) |
| POST | `/ingress/validate_session` | only HA Core | validate session |

Do not invent endpoints: this table is exactly the set documented under `apps/supervisor-api/*` plus the routes registered in `supervisor/api/__init__.py`. `/addons/{slug}/install`, `/update`, `/icon`, `/logo`, `/changelog`, `/documentation` are documented there as "Older path for…" store equivalents.

## 3.3 Example calls

```bash
# no permission needed
curl -sSL -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" http://supervisor/addons/self/info
curl -sSL -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" http://supervisor/addons/self/options/config

# manager role
curl -sSL -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" http://supervisor/addons
curl -sSL -X POST -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" \
     -H "Content-Type: application/json" -d '{"background":true}' \
     http://supervisor/store/addons/local_my_app/install

# HA Core REST through the proxy (homeassistant_api: true)
curl -sSL -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" \
     http://supervisor/core/api/states/sun.sun
curl -sSL -X POST -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" \
     http://supervisor/core/api/config/core/check_config
curl -sSL -X POST -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" \
     -H "Content-Type: application/json" \
     -d '{"entity_id":"light.kitchen","service":"turn_on"}' \
     http://supervisor/core/api/services/light/turn_on
```

---

# 4. Ingress mechanics (the sidebar UI)

Primary sources: https://contributors.home-assistant.io/apps/guides/ingress/ , `api/ingress.py`, `api/const.py`, and HA Core's `homeassistant/components/hassio/ingress.py`.

## 4.1 Request path layering (prefix is stripped twice and re-added for the browser)

1. Browser → Home Assistant: **`/api/hassio_ingress/<token>/<path>`** (token is per-install, from the app's `ingress_token`). HA Core's view is `url = "/api/hassio_ingress/{token}/{path:.*}"` (`requires_auth = False`; auth is carried by the ingress session cookie).
2. HA Core → Supervisor: `http://supervisor/ingress/<token>/<path>` — HA's `_create_url` builds `/ingress/{token}/` + quoted path.
3. Supervisor (`api/__init__.py`): `web.route(METH_ANY, "/ingress/{token}/{path:.*}")`; handler builds **`http://{app.ip_address}:{app.ingress_port}/{path}`** (`ingress.py` `_create_url`). **The `/ingress/<token>/` prefix is stripped**; the app receives `<path>` at its origin root, query string preserved (`if request.query_string: url = f"{url}?{request.query_string}"`).
4. Response: body streamed/copied back; `allow_redirects=False` — redirects from the app are passed to the browser **as-is**, so an app redirect to `/login` becomes a redirect to the HA host root, not to the ingress URL. Use only relative redirects.
5. WebSockets are proxied at both layers (`is_websocket` + `ws_connect`, 16 MiB max message size; HA Core also proxies upgrades). HTTPS: HA terminates TLS; our listener is plain HTTP inside the internal network.

## 4.2 What the Supervisor adds / strips (headers)

From `api/ingress.py` `_init_header` and `api/const.py`:

- **Adds** `X-Remote-User-Id`, `X-Remote-User-Name`, `X-Remote-User-Display-Name`, and (not in the docs, in current source) `X-Remote-User-Groups` (comma-separated group IDs, admin group `system-admin` folded in for owners).
- **Strips from incoming requests**: `Content-Length`, `Content-Encoding`, `Transfer-Encoding`, all `Sec-WebSocket-*`, `X-Supervisor-Token`, `X-Hassio-Key`, and all `X-Remote-User-*` headers (so a client cannot spoof them). `Host`, `Origin`, `Cookie`, `Referer`, `X-Forwarded-*` are **passed through**.
- **`X-Ingress-Path`** is added by **HA Core**, not by the Supervisor: `headers[X_INGRESS_PATH] = f"/api/hassio_ingress/{token}"` in `homeassistant/components/hassio/ingress.py`. So inside the add-on, `X-Ingress-Path` = the external prefix (`/api/hassio_ingress/<token>`, no trailing slash). The Supervisor forwards it unchanged. Docs: "Home Assistant adds the header `X-Ingress-Path` to every request, with the path your app is served under." — https://contributors.home-assistant.io/apps/guides/ingress/#work-with-relative-urls
- HA Core also adds `X-Hass-Source: core.ingress` and `X-Forwarded-For/Host/Proto`.
- **The proxy (both layers) preserves the browser's `Host` header** (not filtered) — relevant to DSH's Host/Origin fence (§4.5).

Trust rule: "The Supervisor removes these headers from incoming requests and sets them itself, so your app can trust them, **as long as it only accepts connections from `172.30.32.2`**." Same page.

## 4.3 Cookies and sessions

- The Supervisor requires the **`ingress_session`** cookie (name: `COOKIE_INGRESS` in `api/const.py`); it is created by HA Core via `POST /ingress/session` (only Core may call) and validated with `/ingress/validate_session`. The `user_id` sent at session creation becomes the user in the `X-Remote-User-*` headers.
- The Supervisor does **not** rewrite cookies produced by the add-on. Whatever `Set-Cookie` headers the app sends (including `Path=/`) are forwarded to the browser on the **HA origin**. See the gap in §4.5.
- The ingress session cookie itself is passed to the app (Cookie header is not filtered) — an app that logs headers will log it. Do not log cookies.

## 4.4 Defining the sidebar panel

```yaml
ingress: true
ingress_port: 8099
# no ingress_entry: the DSH start page is "/" (setting "/" would make ingress_url contain "//")
panel_icon: "mdi:robot-happy-outline"
panel_title: "DeepSeek Harness"
panel_admin: true
```

- The URL is exposed in `GET /addons/self/info` as `ingress_url` (a **path**: `/api/hassio_ingress/<token>/` plus `ingress_entry` when set) and `ingress_entry`. Source: `apps/app.py` `ingress_url` property. Docs: https://contributors.home-assistant.io/apps/guides/ingress/#work-with-relative-urls
- `panel_admin: true` is **enforced at the proxy** (403 for a non-admin ingress session), not just a sidebar visibility flag (`api/ingress.py` handler). Set it `false` only if non-admin household members should reach the agent.
- The user can toggle "Show in sidebar" (`ingress_panel`); `POST /addons/<app>/options {"ingress_panel": true}` does the same programmatically.

## 4.5 Requirements for an app behind ingress, and how DSH maps onto them

From the ingress docs: use **relative URLs** (`static/app.js`, not `/static/app.js`), set `ingress_entry` if the start page is not `/`; use `X-Ingress-Path` for absolute URLs/base path; do not require a login (HA already authenticated the user); only accept connections from `172.30.32.2`.

DSH's own reverse-proxy contract (source: `upstream-dsh/docs/user/guide/public-deployments.md`) requires the proxy to:

1. preserve the browser-facing `Host`;
2. strip the mount prefix;
3. forward `Upgrade`/`Connection` for WebSockets;
4. rewrite cookie `Path` to the mount (and add `Secure` when the external leg is HTTPS);
5. redirect the bare mount (`/mount` → `/mount/`).

HA ingress satisfies 2 and 3, and preserves `Host`, but **does not do 4**, and only 5 by accident (the panel URL ends with `/`). HA ingress also does not let us change the host. Consequences and mitigations:

- **Base path / assets**: DSH serves origin-root routes and "the served document resolves URLs against its own directory" (`public-deployments.md`), i.e. it emits relative asset URLs — so a prefix-stripping proxy works. `--public-url` only *advertises* the root (printed URL, `DSH_WEB_URL`, runtime context) and "grants no trust"; it "configures no listener, routing, or cookie scope" (`packages/bundle/web-app/README.md`). Passing `https://<ha-base>/api/hassio_ingress/<token>/` therefore makes the agent's session/runtime context contain the right prefix, but does not fix cookies.
- **Host/Origin fence**: DSH accepts loopback, its own bind IP, and `--trusted-host` authorities; other authorities get 403 on every `/api` call (`public-deployments.md`; `packages/bundle/web-app/src/startup.ts`). Inside our container the browser-visible host is the user's HA host (e.g. `homeassistant.local:8123` or a Nabu Casa URL), unknown at add-on start. Options: (a) add-on option `public_url` (or `trusted_hosts`) that we feed to `--trusted-host`; (b) run a tiny local reverse proxy (nginx) in the container on 8099 that (i) accepts only `172.30.32.2`, (ii) sets `Host`/`Origin` to the DSH bind address or loopback so the fence accepts, (iii) rewrites `Set-Cookie: Path=/` to `Path=<X-Ingress-Path>/`, (iv) proxies to `127.0.0.1:3080`. The nginx shim is the cleanest fix for both the cookie-scope gap and the unknown host, and is a small addition to the image. **Recommendation: v1 = DSH on 127.0.0.1:3080 + nginx shim on 8099; if time-constrained, DSH directly on `<container-ip>:8099` with `--trusted-host` from options and accept `Path=/` cookies (functional, not ideal).**
- **`--host` cannot be a wildcard**: DSH rejects `0.0.0.0`/`::` and requires one concrete local IP (`startup.ts` help/validation; `README.md`: "wildcard addresses are rejected"). The Supervisor connects to the app's internal IP, so DSH cannot stay on loopback unless the nginx shim proxies; a direct bind must use the container IP (`hostname -i | awk '{print $1}'`), which is exactly the container example in DSH's README.
- **`ingress_stream`**: Supervisor buffers request bodies unless `ingress_stream: true`; POST-only streaming (source `api/ingress.py`). Set it if DSH uploads large images/attachments.
- **Long-lived WebSockets** (agent streaming) are supported at both proxy layers; HTTP/1.x, streaming responses and WebSockets are explicitly listed in the ingress guide.

## 4.6 Exposure / CSRF notes

- With ingress only (no `ports`, no `host_network`) the UI is reachable **only** through HA's authenticated proxy. HA docs recommend this ("It also gives your app the best security rating").
- The Supervisor forwards the browser's `Origin` header unfiltered (`api/ingress.py`); HA's ingress layer does not document any CSRF validation, so origin checks are the add-on's job — DSH's Host/Origin fence is a meaningful second layer.
- The ingress session cookie is HA-side state; a stolen cookie can open the app until it is invalidated. Panel exposure is admin-gated by `panel_admin` at the proxy.

---

# 5. Local add-on dev/build loop (what "add-on management" tools can rely on)

## 5.1 How the Supervisor finds local add-ons

- The Supervisor reads every repository (Git URL or the local apps folder) on store reload, finding `config.yaml|yml|json` at any depth (skipping hidden folders and `rootfs/`). Sources: https://contributors.home-assistant.io/apps/how-apps-work/#from-repository-to-app-store , https://contributors.home-assistant.io/apps/reference/files/
- **Writing files into the mapped local-apps folder is not auto-detected.** Call `POST /store/reload` (alias `POST /addons/reload`) after writing; the docs say explicitly: "Reads all repositories again: pulls the latest changes of the Git repositories **and reads the local apps folder**. Use it after you change the files of a local app." — https://contributors.home-assistant.io/apps/supervisor-api/store/#post-storereload
- The "Check for updates" button in the store UI triggers the same reload; rebuilds are triggered from the app page.

## 5.2 Installing/building a scaffolded add-on

- A local app without `image` is **built on the device by the Supervisor** from its `Dockerfile` using Docker BuildKit; an app with `image` is pulled instead. Sources: https://contributors.home-assistant.io/apps/how-apps-work/#installing-and-building , https://contributors.home-assistant.io/apps/guides/publishing/
- Install: `POST /store/addons/<full_slug>/install` (or the legacy `POST /addons/<full_slug>/install`) — resolves the store app, validates availability, then `App.install()` → build or pull. `manager` role. It is a job; use `background: true` + `GET /jobs/<job_id>` for progress.
- Rebuild after a code change (the slug must already be installed and its version must match the store version): `POST /addons/<slug>/rebuild` with `{"force": true}` to rebuild even for image-based apps (`api/apps` docs). Equivalent CLI: `ha apps rebuild --force local_my_app`; UI: store "Check for updates" then **Rebuild** on the app page. Source: https://contributors.home-assistant.io/apps/guides/testing/#a-real-device
- **No `docker_api` is needed.** The Supervisor runs the build itself with a builder container (`docker/app.py` `_build`, `ADDON_BUILDER_IMAGE = "docker"`); the add-on never talks to the Docker socket. `docker_api: true` only mounts `/run/docker.sock` read-only, works only with protection mode off, and forces security rating 1. Do not use it.
- Update flow: bump `version` in `config.yaml` in the source folder, `/store/reload`, then install/update. `POST /addons/<slug>/update` refuses when the app is detached, when no update is available (`AppNoUpdateAvailableError`), and an app can never update itself (store docs).
- **Build logs**: everything the add-on writes to stdout/stderr is on the app Log tab and `GET /addons/<slug>/logs` (`ha apps logs`). The Supervisor's build output goes to the Supervisor log; on failure the build output is included in the raised error message (`DockerBuildError(f"... Build output:\n{logs}")` in `docker/app.py`), and successful build output is only at debug level (`_LOGGER.debug("Build … done: %s", logs)`). Practical answer: read `GET /supervisor/logs` for build failures, and the app's own log after start. **UNVERIFIED**: precise log level/rendering of successful build output in the UI.

## 5.3 What our agent can safely assume

Sequence for "scaffold and build an add-on": write `config.yaml` + `Dockerfile` + `rootfs/` under `/addons/<new_slug>/` → `POST /store/reload` → `POST /store/addons/local_<new_slug>/install` (job) → if it starts, `GET /addons/local_<new_slug>/info`; if not, `GET /addons/local_<new_slug>/logs` and `GET /supervisor/logs`. To iterate: edit files, `POST /store/reload`, `POST /addons/local_<new_slug>/rebuild {"force":true}`.

---

# 6. Repository, distribution, base image, health semantics

## 6.1 Repository layout (deliverable repo)

Source: https://contributors.home-assistant.io/apps/guides/repository/ and https://contributors.home-assistant.io/apps/reference/files/#repository

```
ha-deepseek-harness/                 # https://github.com/ussdeveloper/ha-deepseek-harness
  repository.yaml                    # REQUIRED at repo root, else Supervisor loads nothing
  README.md
  deepseek_harness/                  # one folder per add-on; config.yaml at any depth
    config.yaml
    Dockerfile                       # required when no `image`
    DOCS.md
    README.md
    CHANGELOG.md
    icon.png                         # 128x128 PNG square recommended
    logo.png                         # ~250x100 PNG, other sizes fine
    apparmor.txt                     # optional; +1 security rating
    translations/en.yaml             # option labels/descriptions
    rootfs/                          # copied by Dockerfile; not scanned for config.yaml
      etc/services.d/dsh/run
      etc/services.d/dsh/finish
      usr/local/bin/dsh-run
```

`repository.yaml`:

```yaml
name: "DeepSeek Harness add-ons"
url: "https://github.com/ussdeveloper/ha-deepseek-harness"
maintainer: "ussdeveloper <you@example.com>"
```

Only `name` is required. The repository ID is the first 8 chars of the lowercased SHA-1 of the URL (branch included): apps installed from it get slugs like `<repoid>_deepseek_harness`. Keep the URL stable. Users add it via **Settings → Apps → Install app → ⋮ → Repositories**.

Icon/logo: `icon.png` square PNG, 128×128 recommended (store/list icon); `logo.png` PNG, around 250×100 recommended. Both optional. Source: https://contributors.home-assistant.io/apps/guides/presentation/#icon-and-logo

## 6.2 Build path for a GitHub repo installed by URL (Lead question 4)

Two mutually exclusive modes, selected per app by the presence of `image`:

| Mode | How it works | When |
|---|---|---|
| **Local build (no `image`)** | HA OS clones the repository and **builds `Dockerfile` on the device with BuildKit** at install/update time. `build.yaml` is not needed — it is deprecated; all build inputs are in the Dockerfile (`FROM`, `ARG`, `LABEL`). Sources: https://contributors.home-assistant.io/apps/guides/publishing/#built-on-the-device-or-pre-built , https://contributors.home-assistant.io/apps/guides/dockerfile/#buildyaml | v1 / development. Slow on ARM, needs internet at build time, **image is exported into every backup** (§1.4). |
| **Prebuilt image (`image: ghcr.io/ussdeveloper/ha-deepseek-harness`)** | HA OS pulls tag `version` (multi-arch manifest; Supervisor picks arch). CI builds/pushes with `home-assistant/builder` actions. | Shipping to users; recommended by the official docs ("Publishing images is better for your users in almost every way"). |

`build.yaml` is **not** a CI-only file — it was the old per-repo build config consumed by the Supervisor/builder; it is deprecated and the builder actions read `config.yaml` + `Dockerfile` instead. `build.yaml` keys map to Dockerfile statements: `build_from` → `FROM`/`ARG BUILD_FROM=...`, `args` → `ARG` defaults, `labels` → `LABEL`, `squash` → no replacement (BuildKit does not support it). Since Supervisor **2026.04.0** `BUILD_FROM` is no longer passed by default; never start the Dockerfile with bare `FROM ${BUILD_FROM}`.

CI (when we publish): GitHub Actions with the composable builder actions — `prepare-multi-arch-matrix` (`aarch64,amd64`) → `build-image` (pushes per-arch like `ghcr.io/ussdeveloper/aarch64-ha-deepseek-harness`) → `publish-multi-arch-manifest` (combines into `ghcr.io/ussdeveloper/ha-deepseek-harness`). Needs `packages: write`; Cosign signing needs `id-token: write`; first GHCR push is private until made public. Old all-in-one `home-assistant/builder` action is deprecated. Source: https://contributors.home-assistant.io/apps/guides/publishing/#build-with-github-actions

**Recommended v1:** ship as a repository with **no `image`** so the user's HA OS builds it (self-contained, no registry credentials, no CI needed), then add the GHCR image + workflow before public release (avoids giant backups and 5–15 min ARM builds). When switching, keep `version` equal to the published tag and push the image before bumping `version`.

## 6.3 Base image / Dockerfile for a Node 24 app

- Official multi-arch base images: `ghcr.io/home-assistant/base` (Alpine), `base-python`, `base-debian`, `base-ubuntu`; they include S6 overlay v3, Bashio, Tempio, `bash/curl/jq/tzdata/CA certs`; pin a tag like `3.24`. Source: https://contributors.home-assistant.io/apps/guides/dockerfile/#base-images
- **Node 24 is in Alpine 3.24 main as `nodejs 24.22.1-r1`** — https://pkgs.alpinelinux.org/package/v3.24/main/x86_64/nodejs . So `FROM ghcr.io/home-assistant/base:3.24` + `RUN apk add --no-cache nodejs=24.22.1-r1` is a viable v1 (pin the version; Alpine repo versions move). If native modules misbehave on musl (node-pty/sandbox), use `base-debian:trixie` + Node from NodeSource/tarball, or a multi-stage build with `node:24-alpine`/`node:24-bookworm-slim` as builder. **The final choice depends on native deps — owned by `docs/research/dsh-container.md`.**
- With HA base images: `init: false`, `CMD` or S6 services, do **not** set `ENTRYPOINT`, do not `host_pid: true` (S6 cannot run as PID 1 otherwise). Build args available: `BUILD_ARCH`, `BUILD_VERSION`; `Dockerfile.aarch64`/`Dockerfile.amd64` override per-arch. Labels (`io.hass.type=app`, `io.hass.version`, `io.hass.arch`) are added by the Supervisor/builder automatically. Source: https://contributors.home-assistant.io/apps/guides/dockerfile/#build-arguments , .../s6-overlay/
- Image size/startup: Alpine preferred for SD-card devices; Supervisor waits up to **120 s** for the "started" state of a healthchecked app (`STARTUP_TIMEOUT = 120` in `apps/app.py`) and a timeout is **not** treated as failure ("Timeout waiting for startup is not a failure, app is probably just slow" — `apps/manager.py` `boot()`). Keep the container running during slow agent startup (S6 longrun) rather than exiting.

## 6.4 Backups, watchdog, health (Lead questions 2 & 4)

**Backups**

- Manifest: `backup: hot` (default) or `cold`; `backup_pre`/`backup_post` (hot only); `backup_exclude` globs. Source: https://contributors.home-assistant.io/apps/reference/configuration/#backups
- A backup of the add-on contains its `/data` folder and, if mapped, its public `app_config` folder (https://contributors.home-assistant.io/apps/how-apps-work/#backups); `homeassistant_config`/`local_apps`/`share`/`media` mounts are **not** part of the add-on backup (they are outside the app). So DSH memory/state **must live in `/data`** to be backed up.
- **Locally built add-ons also back up their image** (`apps/app.py` `backup()` → `export_image` if `need_build`) — another reason to move to a prebuilt image.
- For a SQLite session DB, a hot backup can capture a torn DB. **Recommendation v1: `backup: cold`** (Supervisor stops the add-on for the backup) or keep `hot` but add `backup_pre`/`backup_post` commands that checkpoint/freeze DSH's DB (only if DSH has such a command — UNVERIFIED). `cold` is the safe default and docs explicitly describe it as "stops it during the backup".
- `backup_exclude` patterns are matched against the path as the Supervisor sees it (`/data/...` plus relative); use simple basename/one-level globs (`*.log`, `tmp/*`, `cache/*`). Avoid relying on `**` recursion — Python `Path.match` semantics (UNVERIFIED for recursive patterns).

**Watchdog / health semantics**

- No `healthcheck:` key. Two independent mechanisms:
  1. **Docker `HEALTHCHECK`** in the image (if present): Supervisor derives app state `STARTUP` until healthy; `watchdog_container` reacts to `UNHEALTHY` (`apps/app.py`). If we add one, use a generous `--start-period`/`--interval` so a slow agent start is not marked unhealthy.
  2. **`watchdog` URL** probe: `tcp://[HOST]:[PORT:x]` = TCP connect check; `http(s)://[HOST]:[PORT:x]/path` = GET, any status `< 300` healthy (`watchdog_application`, 10 s timeout). The probe runs only when the user enables the Watchdog toggle (user setting, default off; `SCHEMA_APP_USER` `watchdog` default `False`).
- Restart policy: if the container is `FAILED`, `STOPPED` or `UNHEALTHY` while the watchdog is on, the Supervisor restarts with exponential backoff, `WATCHDOG_MAX_ATTEMPTS = 5`, throttle `30 min / 10 calls`, retry base `10 s` (`apps/const.py`, `apps/app.py`). Apps with `startup: once` never get a watchdog.
- For a slow booting agent: `startup: application` (after Core), keep the S6 longrun in the foreground, expose a cheap `/healthz` if DSH can (else TCP watchdog on 8099), and do not declare failure from the startup script while the server is still booting.

## 6.5 Versioning rules

`version` is the single source of truth: UI version, image tag, update comparison. Push the image tag **before** bumping `version` in the repo; never re-push a different image under an existing tag; use a sortable scheme (SemVer or date); list incompatible releases in `breaking_versions` so automatic updates never cross them; set `homeassistant` for a minimum Core version. Source: https://contributors.home-assistant.io/apps/guides/publishing/#versions

---

# 7. Security model

## 7.1 What the token can do

- `SUPERVISOR_TOKEN` is per-app and always authenticates the app to the Supervisor; what it *may* do is fixed by `config.yaml` at container creation (`hassio_api` + `hassio_role`).
- `homeassistant_api: true` makes the token an **HA administrator credential** through `/core/api`: "Everything else an administrator can do, your app can do too, including managing users and their credentials." — https://contributors.home-assistant.io/apps/guides/communication/#home-assistant-core
- `hassio_role: manager` = manage apps/store/backups/Core/host/OS/plugins, but **not** protection-mode changes, data-disk wipe, or host SSH keys. `admin` = everything, including toggling protection mode for any app (https://contributors.home-assistant.io/apps/guides/security/#api-roles).
- **Static, not option-driven.** Role/flags are manifest properties; an add-on option cannot widen or narrow the token at runtime. Options can only gate the tool implementations (defense in depth, not a security boundary). If we want a genuinely read-only variant, it must be a second `config.yaml`/slug (e.g. `deepseek_harness_ro`).

## 7.2 Recommended least privilege for our feature set

| Need | Manifest choice | Why |
|---|---|---|
| Run and expose a UI | `ingress: true`, no `ports`, `host_network: false` | Only reachable through HA's authenticated proxy; best rating (+2). |
| Read/control HA entities | `homeassistant_api: true` | Proxy—no user token needed; **but it is HA admin**. Accept only if the product really edits automations/calls services. |
| List/manage apps, build local add-ons, read backups | `hassio_api: true`, `hassio_role: manager` | Required for `/addons`, `/store*`, `/addons/*/rebuild`, `/backups`; `admin` unnecessary (we do not change protection mode). |
| Container/host access | none | no `docker_api` (builds are Supervisor's job), no `privileged` caps, no `host_pid`/`host_uts`/`host_dbus`, no `full_access`, no device groups. |
| Filesystem | `/config` rw only if YAML editing is a feature; `/addons` rw for building; everything else ro or unmapped | Each rw mount is host data the agent (and any prompt injection) can destroy. |
| Hardening | `apparmor: true` + custom `apparmor.txt` (later), `init: false`, `boot: auto`, `panel_admin: true` | +1 rating with profile, no exposure to non-admins. |

Resulting rating: 5 (base) + 2 (ingress) − 1 (manager) = **6/8**; **7/8** once a custom AppArmor profile loads (rating table: https://contributors.home-assistant.io/apps/reference/security-rating/).

## 7.3 Prompt-injection / agent-specific risk

The agent is a *tool-using LLM* holding, in the worst case: HA admin, the user's HA `/config` rw, and the ability to create and install an add-on. That means a malicious prompt (blog content, entity names, a file in `/config`, a GitHub issue fetched as research) could plausibly:

- call dangerous services (`homeassistant.restart`, `shell_command`, `python_script`, `hassio.*` is blocked through the proxy but the Supervisor API is not);
- edit/delete `/config` (`secrets.yaml`, `.storage/*` → credentials, auth, device registry);
- create a local add-on and **install it** (`/store/addons/.../install` needs only `manager`), including one with `host_network`/`/config:rw`/devices — a persistence/escalation primitive that does not require Docker access;
- read backups via `/backups` (contains secrets!) if given manager.

Mitigations that belong **in the manifest/config** and that we can enforce:

1. `panel_admin: true` (proxy-enforced 403 for non-admins).
2. Ingress-only, no `ports`, no `host_network`: no LAN exposure of an unauthenticated-ish agent UI.
3. `hassio_role: manager` (never `admin`); do not grant `docker_api`/`full_access`/`host_network`/`privileged`.
4. AppArmor profile fitted to node + `/data` + `/config` (blocks the rest of the container filesystem, exec of unexpected binaries, and signal tricks).
5. Add-on options that **gate the tool surface** (defaults: `allow_restarts: false`, `allow_addon_management: false`, `read_only: true`) — and the plugin must enforce them; document that this is a guardrail, not a sandbox (see 7.1/7.2).
6. Treat `/config` as sensitive: prefer backups of edited files (`.bak`/git in a subdir), never print `secrets.yaml`/`.storage`; never expose `/backups` contents to the model by default.
7. `backup: cold` + small `backup_exclude` so user backups are consistent and bounded.
8. Secrets: options with `password` schema type are stored in HA's add-on options (and `/data/options.json`); support `!secret` references (Supervisor resolves them before writing options.json — https://contributors.home-assistant.io/apps/guides/options/#secrets). Never bake keys into the image; never log `/data/options.json`.
9. The add-on log contains the DSH launch URL, which contains a process credential (`packages/bundle/web-app/README.md`: "The printed URL contains a process credential"); add-on logs are readable by HA admins — acceptable, but do not echo it from our scripts.
10. Consider shipping a **read-only twin add-on** (`deepseek_harness_ro`: no `hassio_api`, `/config` ro, no local-apps map) for monitoring/chat-only users; that is the only way to make least privilege a *choice* rather than a doc note.

---

# 8. Proposed add-on for `ussdeveloper/ha-deepseek-harness`

## 8.1 `deepseek_harness/config.yaml` (concrete, valid)

```yaml
name: "DeepSeek Harness"
version: "0.1.0"
slug: "deepseek_harness"
description: "DeepSeek Harness agent Web UI with Home Assistant access, built for HA OS"
url: "https://github.com/ussdeveloper/ha-deepseek-harness"
arch:
  - aarch64
  - amd64
init: false
startup: application
boot: auto
stage: experimental

# v1: no `image` -> HA OS builds the Dockerfile on the device.
# Before public release switch to a prebuilt multi-arch image, e.g.:
# image: "ghcr.io/ussdeveloper/ha-deepseek-harness"

ingress: true
ingress_port: 8099
# no ingress_entry: the DSH UI starts at "/" (an entry of "/" would render ingress_url with "//")
ingress_stream: true
panel_icon: "mdi:robot-happy-outline"
panel_title: "DeepSeek Harness"
panel_admin: true

hassio_api: true
hassio_role: manager
homeassistant_api: true
# docker_api: false (default) - Supervisor builds images itself, we never need the socket
# host_network: false (default) - ingress-only

map:
  - type: homeassistant_config
    read_only: false
    path: /config            # HA config at /config (modern type, explicit mount point)
  - type: local_apps
    read_only: false
    path: /addons            # host local add-ons folder at /addons (modern type)
  - type: share
    read_only: true
  - type: ssl
    read_only: true

options:
  model: "deepseek-chat"
  base_url: "https://api.deepseek.com"
  read_only: true
  allow_restarts: false
  allow_addon_management: false
  monitor_enabled: true
  notify_service: ""
  backup_retention: 7
  quiet_hours: "22:00-07:00"
  public_url: ""

schema:
  deepseek_api_key: "password?"
  model: "str"
  base_url: "url"
  read_only: "bool"
  allow_restarts: "bool"
  allow_addon_management: "bool"
  monitor_enabled: "bool"
  notify_service: "str?"
  backup_retention: "int(1,90)"
  quiet_hours: "match(^([01][0-9]|2[0-3]):[0-5][0-9]-([01][0-9]|2[0-3]):[0-5][0-9]$)?"
  public_url: "str?"

environment:
  DSH_HOME: "/data/dsh"
  NODE_ENV: "production"

watchdog: "tcp://[HOST]:[PORT:8099]"
backup: cold
backup_exclude:
  - "*.log"
  - "tmp/*"
  - "cache/*"
timeout: 30

# apparmor: true (default) + an apparmor.txt in this folder
```

Notes:
- `deepseek_api_key` is deliberately `password?` and **absent from `options`** so it stays unset until the user fills it (docs: leave optional options out of `options`); it is still shown in the Configuration form.
- `base_url` uses the `url` schema type and therefore must be a valid URL; if users need a local/OpenAI-compatible base that is still a URL, fine.
- `quiet_hours` uses `match(regex)`; the regex above is a starting point (empty allowed via `?`).
- All options are validated by the Supervisor before start and written to `/data/options.json`; **changing an option requires an add-on restart** (https://contributors.home-assistant.io/apps/guides/options/#read-the-options).
- `panel_admin: true` + `ingress: true`: the sidebar entry appears for admins; non-admins get 403 unless the user sets `panel_admin: false` in a rebuild (source-enforced).

## 8.2 `rootfs/usr/local/bin/dsh-run` (the `run.sh` skeleton)

Wired as an S6 **longrun** (`rootfs/etc/services.d/dsh/run` = `#!/command/with-contenv bashio` + `exec /usr/local/bin/dsh-run`; HA base image contract: https://contributors.home-assistant.io/apps/guides/s6-overlay/). Env var names for DSH settings are **placeholder** until `docs/research/dsh-container.md` fixes them.

```bash
#!/command/with-contenv bashio
# /usr/local/bin/dsh-run - S6 longrun for the HA add-on.
# Reads HA options, prepares persistent state, then execs the DSH Web UI.
set -euo pipefail

export DSH_HOME="/data/dsh"
export HOME="/data"                 # keep tool caches off the readonly image layer
mkdir -p "${DSH_HOME}/profiles" "${DSH_HOME}/sessions" "${DSH_HOME}/memory"

# --- options -> environment (bashio asks the Supervisor; /data/options.json is
#     the same data for non-shell consumers) ------------------------------------
MODEL="$(bashio::config 'model')"
BASE_URL="$(bashio::config 'base_url')"
READ_ONLY="$(bashio::config 'read_only')"
ALLOW_RESTARTS="$(bashio::config 'allow_restarts')"
ALLOW_ADDONS="$(bashio::config 'allow_addon_management')"
MONITOR="$(bashio::config 'monitor_enabled')"
NOTIFY="$(bashio::config 'notify_service' '')"
RETENTION="$(bashio::config 'backup_retention')"
QUIET="$(bashio::config 'quiet_hours' '')"
PUBLIC_URL_OPT="$(bashio::config 'public_url' '')"

# TODO(dsh-container): confirm exact DSH env/config names and map:
export DSH_MODEL="${MODEL}"                    # placeholder env name
export DSH_BASE_URL="${BASE_URL}"              # placeholder env name
export DSH_READ_ONLY="${READ_ONLY}"            # our plugin uses these
export DSH_ALLOW_RESTARTS="${ALLOW_RESTARTS}"
export DSH_ALLOW_ADDON_MANAGEMENT="${ALLOW_ADDONS}"
export DSH_MONITOR_ENABLED="${MONITOR}"
export DSH_NOTIFY_SERVICE="${NOTIFY}"
export DSH_BACKUP_RETENTION="${RETENTION}"
export DSH_QUIET_HOURS="${QUIET}"

if bashio::config.has_value 'deepseek_api_key'; then
  export DEEPSEEK_API_KEY="$(bashio::config 'deepseek_api_key')"   # placeholder env name
fi

# --- ingress wiring ----------------------------------------------------------
# Supervisor reaches us at <container-ip>:<ingress_port>; DSH refuses wildcard binds.
BIND_IP="$(hostname -i | awk '{print $1}')"
INGRESS_PORT="$(bashio::app.ingress_port)"          # 8099
INGRESS_PATH="$(bashio::app.ingress_url)"           # /api/hassio_ingress/<token>/

ARGS=(--profile web --no-open --host "${BIND_IP}" --port "${INGRESS_PORT}")

# Optional: advertise the browser-facing root so DSH_WEB_URL/runtime context are
# right, and trust that authority (Host/Origin fence). Requires the user's HA URL.
if [ -n "${PUBLIC_URL_OPT}" ]; then
  ARGS+=(--public-url "${PUBLIC_URL_OPT%/}${INGRESS_PATH}")
  # strip scheme/path -> authority for --trusted-host
  AUTHORITY="${PUBLIC_URL_OPT#*://}"; AUTHORITY="${AUTHORITY%%/*}"
  ARGS+=(--trusted-host "${AUTHORITY}")
fi

bashio::log.info "Starting DeepSeek Harness on ${BIND_IP}:${INGRESS_PORT} (ingress: ${INGRESS_PATH})"
exec dsh "${ARGS[@]}"
```

Notes:
- **Do not** put the API key on the command line; export it. Options are also readable from `/data/options.json` (`jq -r .model /data/options.json`) for non-Bash consumers.
- `bashio::app.ingress_port`/`ingress_url`/`ingress_entry` exist (https://contributors.home-assistant.io/apps/bashio/apps/). They call the Supervisor API, so keep `with-contenv`.
- If the nginx-shim architecture is chosen, this script binds DSH to `127.0.0.1:3080` and starts nginx on `8099` accepting only `172.30.32.2`, proxying with `Host`/`Origin` set as DSH requires and rewriting `Set-Cookie` `Path`. See §4.5.
- s6 note: if using S6 `s6-rc` instead of `/etc/services.d`, add the longrun under `rootfs/etc/s6-overlay/s6-rc.d/dsh/` with `type=longrun`, `dependencies.d/base`, and an entry in `user-bundles.d/user/contents.d/`. Scripts must be executable and LF-only (https://contributors.home-assistant.io/apps/guides/s6-overlay/#common-mistakes).

## 8.3 `Dockerfile` sketch (v1, HA base + Node 24)

```dockerfile
FROM ghcr.io/home-assistant/base:3.24

ARG BUILD_ARCH
ARG BUILD_VERSION

# Node 24 from Alpine 3.24 main (pin the exact version)
RUN apk add --no-cache nodejs=24.22.1-r1
# TODO(dsh-container): install DSH (npm package or prebuilt bundle) exactly as
# decided in docs/research/dsh-container.md, e.g.:
#   RUN npm install -g @deepseek-ai/dsh@<version>
# or COPY a prebuilt bundle into /opt/dsh

COPY rootfs /
RUN chmod +x /usr/local/bin/dsh-run /etc/services.d/dsh/run

LABEL \
  io.hass.name="DeepSeek Harness" \
  io.hass.description="DeepSeek Harness agent Web UI for Home Assistant" \
  io.hass.type="app" \
  io.hass.arch="${BUILD_ARCH}" \
  io.hass.version="${BUILD_VERSION}"

# No HEALTHCHECK in v1: the watchdog URL (tcp 8099) covers liveness. If DSH
# gains a /healthz, add HEALTHCHECK with a generous --start-period instead.
```

`init: false` is mandatory for HA base images; do not set `ENTRYPOINT`; S6 runs our service.

## 8.4 What lives where (persistence contract)

| Path | Content | Persisted by HA backup? |
|---|---|---|
| `/data/dsh` (`DSH_HOME`) | profiles, session DB, memory files, schedules, plugin state, config backups | **yes** (`/data` is in the add-on backup) |
| `/data/options.json` | rendered options incl. API key | yes (and it is plaintext — treat backups as secrets) |
| `/config` | Home Assistant configuration (mapped) | no (HA's own backups handle it) |
| `/addons` | local add-ons the agent scaffolds | no (not part of app backup; users' own add-on backups cover installed apps) |
| image | built/pulled | locally built images are exported into the add-on backup (`apps/app.py`), prebuilt ones are not |

---

# 9. Open questions / must verify on a real HA OS instance

1. **DSH CLI/env contract** (owned by task-2): exact runtime invocation (`dsh --profile web` vs `dsh web`), env var names for model/base-url/API key, permission modes, `DSH_HOME` layout, offline plugin install. Our `run.sh` placeholders depend on it.
2. **Ingress Host/Origin fence**: confirm what `Host`/`Origin` the app actually receives through HA ingress (browser HA host vs rewritten), and whether `--trusted-host` from an add-on option is sufficient or the nginx shim is required. Also confirm cookie `Path` behavior (`Set-Cookie` passthrough) and whether a `/api` 403 appears in practice.
3. **`ingress_stream: true`** with DSH/Node: streaming POST bodies can break some webservers; test file upload >16 MiB before enabling in the release manifest.
4. **`homeassistant_config` + `path: /config`**: path override is allowed per source and docs, but verify on real HA OS that the mount appears at `/config` and that no translation/permission surprise occurs (it is the modern equivalent of the deprecated `config` type).
5. **Local apps path**: verify `/addons` mapping with `local_apps` + `path: /addons` and that `/store/reload` picks up a scaffolded folder; confirm the full slug is `local_<slug>` and install/rebuild/build-log loop works end-to-end.
6. **Backups with `cold`** on a slow DSH: measure stop time (Supervisor SIGKILLs after `timeout: 30`); confirm session SQLite restores cleanly.
7. **Health**: decide whether to add `HEALTHCHECK` (needs `/healthz` in DSH) vs TCP watchdog; confirm the watchdog probe interval/reaction in a real Supervisor (source shows 10 s timeout, 5 attempts, backoff — but not the check interval).
8. **`supervisor_api_tcp` migration**: if a future Supervisor disables the TCP API, `SUPERVISOR_TOKEN` disappears and `SUPERVISOR_SOCKET` is injected instead; our bashio-based scripts would need a socket client. Track Supervisor changes; do not set the key.
9. **`image` vs local build**: decide release timing for GHCR multi-arch (backup size, ARM build time) and make sure the published tag equals `version` exactly.
10. **AppArmor profile**: write and complain-mode-test one for Node/DSH (`/data`, `/config`, network, node_modules); expect +1 rating.
11. **Non-admin users**: confirm `panel_admin: true` 403 and decide whether to offer an option/rebuild instruction to set `false`.
12. **Read-only twin add-on**: decide if we ship `deepseek_harness_ro` (no `hassio_api`, `/config` ro, no local-apps) to give users a real least-privilege choice.
13. **Icon/logo assets**: produce 128×128 `icon.png` + ~250×100 `logo.png`, readable on light/dark.
14. **`high-level Docs`**: confirm the DSH license/attribution and any trademark constraints for the icon/name in a public HA repository.

---

# Appendix A — citation index

- Config reference (all keys, defaults): https://contributors.home-assistant.io/apps/reference/configuration/
- Schema validation source: https://github.com/home-assistant/supervisor/blob/main/supervisor/apps/validate.py
- Map types source: https://github.com/home-assistant/supervisor/blob/main/supervisor/apps/const.py
- Mount implementation: https://github.com/home-assistant/supervisor/blob/main/supervisor/docker/app.py ; paths: https://github.com/home-assistant/supervisor/blob/main/supervisor/docker/const.py
- App model (`ingress_url`, backup, watchdog): https://github.com/home-assistant/supervisor/blob/main/supervisor/apps/app.py
- Boot/startup/rebuild jobs: https://github.com/home-assistant/supervisor/blob/main/supervisor/apps/manager.py
- Supervisor API overview/roles/auth: https://contributors.home-assistant.io/apps/supervisor-api/
- API endpoints: https://contributors.home-assistant.io/apps/supervisor-api/apps/ , .../store/ , .../core/ , .../supervisor/ , .../services/ , .../backups/ , .../host/
- API routes source: https://github.com/home-assistant/supervisor/blob/main/supervisor/api/__init__.py
- Ingress proxy source (Supervisor): https://github.com/home-assistant/supervisor/blob/main/supervisor/api/ingress.py
- Ingress constants (`ingress_session`): https://github.com/home-assistant/supervisor/blob/main/supervisor/api/const.py
- Ingress proxy source (Core, `X-Ingress-Path`): https://github.com/home-assistant/core/blob/master/homeassistant/components/hassio/ingress.py
- Ingress guide: https://contributors.home-assistant.io/apps/guides/ingress/
- Communication / HA proxy / auth headers: https://contributors.home-assistant.io/apps/guides/communication/
- Options/schema: https://contributors.home-assistant.io/apps/guides/options/
- S6 overlay: https://contributors.home-assistant.io/apps/guides/s6-overlay/
- Dockerfile/base images/labels/build args: https://contributors.home-assistant.io/apps/guides/dockerfile/
- Publishing/builder/versions: https://contributors.home-assistant.io/apps/guides/publishing/
- Repository layout/ID: https://contributors.home-assistant.io/apps/guides/repository/
- Files/icon/logo: https://contributors.home-assistant.io/apps/reference/files/ , https://contributors.home-assistant.io/apps/guides/presentation/
- How apps work (install/build/boot/backups): https://contributors.home-assistant.io/apps/how-apps-work/
- Security/API roles: https://contributors.home-assistant.io/apps/guides/security/
- Security rating math: https://contributors.home-assistant.io/apps/reference/security-rating/
- Bashio app functions: https://contributors.home-assistant.io/apps/bashio/apps/
- Node 24 in Alpine 3.24: https://pkgs.alpinelinux.org/package/v3.24/main/x86_64/nodejs
- DSH local sources: `upstream-dsh/packages/bundle/web-app/src/startup.ts`, `upstream-dsh/packages/bundle/web-app/README.md`, `upstream-dsh/docs/user/guide/public-deployments.md`
