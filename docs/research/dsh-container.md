# Running DeepSeek Harness (DSH) in a Home Assistant add-on container

Research deliverable for task-2. Target: `@deepseek-ai/dsh@0.2.2-rc.1` (published npm), Home Assistant
OS with the Supervisor, ingress-only exposure, all state on `/data`.

Everything marked **VERIFIED** was executed on the research host:

| Item | Value |
|---|---|
| Host | Windows 11, `pwsh` |
| Node | `v24.16.0` |
| npm | `11.13.0` |
| DSH CLI | `0.2.2-rc.1` from npm (`engines.node: >=24.9.0`) |
| Local DSH install | `scratch/ds-install/node_modules/@deepseek-ai/dsh` (652 packages) |
| Test `DSH_HOME` | `scratch/dsh-home` |
| Upstream source (read-only) | `upstream-dsh` at `0.2.2-rc.1` (commit `c59d10a`) |

Docker was not reachable from this machine, so container behavior was reproduced with plain Node on the
host and the upstream source (Dockerfile itself is UNVERIFIED, but every command in it was run natively).

---

## 1. Running the Web UI headless in a container

### 1.1 Install

Install the published package globally in the image; do not use `npx` at runtime (it resolves/downloads
on every start, needs network, and hides the real install):

```dockerfile
# Debian, not Alpine — see §5
FROM node:24-bookworm-slim
RUN npm install -g @deepseek-ai/dsh@0.2.2-rc.1
```

The published tarball is self-contained: the bundles it boots (`@deepseek-ai/dsh-base`,
`@deepseek-ai/dsh-web-app`) are production dependencies of `@deepseek-ai/dsh`, the built Web frontend
ships as `@deepseek-ai/dsh-web-frontend`, and no network is needed once installed (**VERIFIED**: local
`npm install @deepseek-ai/dsh@0.2.2-rc.1 --prefix scratch/ds-install` installed 652 packages; the server
then served the full UI offline).

`npx @deepseek-ai/dsh ...` does work but is only suitable for one-off trials.

### 1.2 Boot command

```sh
dsh web --patch /opt/ha-dsh/profile.patch.yml \
        --no-open --host 127.0.0.1 --port 3080 \
        --trusted-host dsh.local
```

`dsh web` is shorthand for `dsh --profile web`. Launcher flags (`--profile`, `--patch`,
`--from-default-profile`, `--dump-config*`) must come **before** any app flag. This fails:

```text
$ dsh web --no-open --patch x.yml
error: unknown option '--patch'          # launcher stopped at --no-open; --patch went to the app
```

### 1.3 Listener flags (all VERIFIED against `packages/bundle/web-app/src/startup.ts` + runtime)

| Flag | Behavior |
|---|---|
| `--host <ip>` | ONE concrete IPv4/IPv6 literal of a local interface. Wildcards are rejected: `error: --host 0.0.0.0 is an unspecified (wildcard) address, which is not supported…` (**VERIFIED**). Bind `127.0.0.1` inside the container; the ingress shim reaches it on loopback. |
| `--port <n>` | Default 3080. `0` lets the OS pick. |
| `--no-open` | Suppress the default-browser handoff (mandatory in a container). |
| `--public-url <url>` | Advertisement only: printed/opened URL, `DSH_WEB_URL`, and the Web GUI URL in agent runtime context. It configures **no** routing, base path, or trust. |
| `--trusted-host <authority...>` | Extra authority the `/api` Host/Origin fence accepts (`host` or `host:port`, repeatable). |
| `--tls-cert` / `--tls-key` | Serve TLS from the listener. Not needed behind HA ingress (Supervisor ↔ add-on stays plain HTTP on the internal network). |

Startup prints one readiness line carrying the **per-process launch token**:

```text
dsh web: http://127.0.0.1:3199/?token=9kIuK6jXzd7oss_brR8UDwa70IBbkGwrNi9IFMfZ27g   # VERIFIED
```

### 1.4 Does DSH web have authentication? Yes.

Two layers, both required by every API call and WebSocket stream:

1. **Process launch token** — random 32-byte token minted per process, only printed on the startup line.
   `GET /?token=<token>` exchanges it for a signed cookie and `303`s to `./`
   (**VERIFIED**: `303 See Other`, `location: ./`, `set-cookie: dsh-auth-…; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`).
2. **HMAC-signed cookie** bound to the request authority (host), with the signing secret persisted in
   `$DSH_HOME/.credentials.yaml`, so browser sessions survive restarts until the cookie expires (30 days
   default, `cookieMaxAgeDays`).

Without a token or cookie the index answers `401` (**VERIFIED**). Still: the cookie/secret is one factor
tied to the *authority string*, so never expose the DSH port directly — keep it loopback-only and let HA
ingress (which authenticates the HA user) be the only path in.

### 1.5 The `/api` browser-trust fence (VERIFIED with curl)

`isTrustedApiRequest` (source: `packages/client/connection/src/api-request-trust.ts`):

- **Host fence**: `Host` must be loopback, the listener's own bind IP, or a `--trusted-host` authority.
- **Origin fence**: when `Origin` is present it must equal the accepted Host authority; absent Origin is fine.
- **Cross-site fence**: `Sec-Fetch-Site: cross-site` is always refused.

Observed on `GET /api/does-not-exist` (404 = fence+auth passed, 401 = auth failed, 403 = fence refused):

| Host | Origin / Sec-Fetch-Site | Cookie | Result |
|---|---|---|---|
| `127.0.0.1:3199` | – | from 127.0.0.1 exchange | 404 |
| `evil.example` | – | yes | **403** |
| `dsh.local` (trusted) | – | cookie minted for 127.0.0.1 | 401 (cookie authority mismatch) |
| `dsh.local` | `https://ha.local` | valid for dsh.local | **403** (Origin ≠ Host) |
| `dsh.local` | `http://dsh.local` | valid | 404 |
| `dsh.local` | `Sec-Fetch-Site: cross-site` | valid | **403** |

Consequence for the shim: fix **one** upstream authority (e.g. `dsh.local`) for both the token exchange
and every later request, pass it as `--trusted-host dsh.local`, and drop/rewrite the browser `Origin`.

### 1.6 Routes and the WebSocket path

| Path | Kind |
|---|---|
| `/` | index (token exchange / cookie check) |
| `/connect` | API-client token exchange (`302` → `./api/remote.mux`) |
| `/api/*` | shared RPC channel (`/api/remote.mux` is the WebSocket mux) |
| everything else | static dist files (`./assets/…`), 404 otherwise |

---

## 2. Ingress prefix behavior (the important finding)

### 2.1 HA ingress does not strip the prefix

Per the Home Assistant developer docs ([Add a web interface with ingress](https://contributors.home-assistant.io/apps/guides/ingress/)),
the browser talks to `/api/hassio_ingress/<token>/`, and the Supervisor forwards to the add-on while
adding `X-Ingress-Path: /api/hassio_ingress/<token>` (and `X-Remote-User-*`). The add-on must handle
the changing path itself — this is why HA docs keep repeating "use relative URLs everywhere" and why
nginx examples need `proxy_pass`/sub-filters.

### 2.2 DSH has no base-path support, but needs none for assets

- The static server resolves the request path against the dist root
  (`packages/host/frontend-static/src/index.ts`): a request for `/api/hassio_ingress/<token>/` is a
  **404**. There is no base-path or `X-Ingress-Path` handling anywhere in DSH 0.2.2-rc.1.
- Index rendering injects `<base href="./">` before every other head injection, and every reference in
  the served HTML is relative (`./assets/index-*.js`, `./manifest.webmanifest`, `plugins/??…`).
  API calls are relative too (`./api/remote.mux`), and the token exchange redirects to `./`.
- Therefore: **no HTML/JS rewriting is needed.** Serve the document at a path ending in `/` and all
  browser-side URLs resolve under the ingress prefix automatically (**VERIFIED**: document fetched
  through a stripping proxy at `/api/hassio_ingress/TESTTOK/` contains `<base href="./">` and
  `src="./assets/index-BgUyXZcc.js"`, and that asset returned 200 / 970,770 bytes through the prefix).
- `--public-url https://ha.local/api/hassio_ingress/<token>/` would only change advertising (printed
  URL, `DSH_WEB_URL`, agent runtime context); it does not make the listener serve the prefix, and the
  ingress token changes per HA session, so advertising it is pointless. **Recommendation: do not set
  `--public-url`.** The shim learns the real prefix per request from `X-Ingress-Path`.

### 2.3 Recommended design: in-container shim on `ingress_port` 8099

`dsh web` binds `127.0.0.1:3080` (loopback only). A ~120-line Node shim binds `0.0.0.0:8099` (the
add-on's `ingress_port`) and:

1. Strips the ingress prefix: `X-Ingress-Path` when present, else `/api/hassio_ingress/<token>` parsed
   from the path. A request for the bare prefix (no trailing slash) gets `308` → `prefix + '/'`
   (**VERIFIED**).
2. Rewrites `Host` to a fixed authority `dsh.local` (the value passed to `--trusted-host`).
3. Drops `Origin` (HA ingress is same-origin by construction and is the only way in; the Host fence plus
   the cookie still apply; `Sec-Fetch-Site: cross-site` is still refused by DSH).
4. Injects the DSH launch token: on `GET /` with no `dsh-auth-*` cookie, append `?token=<launchToken>`
   so the browser mints its session cookie without a human copying the printed URL
   (**VERIFIED**: 303 + `set-cookie`, then 200 with the cookie jar).
5. Rewrites `Set-Cookie` `Path=/` to `Path=<X-Ingress-Path>/` so the cookie is not sent to every HA
   endpoint (**VERIFIED**: `Path=/api/hassio_ingress/TESTTOK/`). Keep the rest of the cookie
   (`HttpOnly; SameSite=Strict`) untouched — do **not** add `Secure`, because the Supervisor terminates
   TLS and HA's own ingress cookie handling is out of our scope; a `Secure` cookie over the internal
   HTTP hop would still be stored by browsers for the HTTPS HA origin, so either choice works. Leaving
   HA's host-only cookie without `Secure` is the conservative choice.
6. Proxies `Upgrade` requests one-to-one (`Connection`/`Upgrade`/`Sec-WebSocket-*` preserved) — the WS
   mux is `/api/remote.mux` (**VERIFIED**: raw handshake through the shim returns
   `101 Switching Protocols` with the correct `sec-websocket-accept`).
7. Refuses peers other than the Supervisor (`172.30.32.2`) unless `DSH_ALLOW_ANY_REMOTE=1`.

**How the shim gets the launch token:** `dsh web` prints exactly one line on stdout, after the Loader
tree settles, of the shape

```text
dsh web: <advertised-url>/?token=<43-char base64url>\n
```

This is the only place the token exists: it is a per-process `randomBytes(32)` value held in memory, it is
never written to a file, and `$DSH_HOME/.credentials.yaml` holds only the persistent HMAC signing secret
for cookies (so browser cookies survive restarts, but a new process always needs a fresh token). The
shim captures it by reading the child's stdout until the regex `/dsh web: (\S+)/` matches, parses
`new URL(match).searchParams.get('token')`, and re-parses on every `dsh web` restart (the browser's old
cookie keeps working because the signing secret persisted). `printUrl: false` would suppress the line, so
do not disable it.

**Verified request flow through the shim** (all with `X-Ingress-Path: /api/hassio_ingress/TESTTOK`):

| Request (browser side) | Shim action | Result |
|---|---|---|
| `GET /api/hassio_ingress/TESTTOK` | bare prefix | `308` → `location: /api/hassio_ingress/TESTTOK/` |
| `GET /api/hassio_ingress/TESTTOK/` (no cookie) | strip→`/`, Host `dsh.local`, drop Origin, append `?token=` | `303`, `location: ./`, `set-cookie: dsh-auth-…; Path=/api/hassio_ingress/TESTTOK/; HttpOnly; SameSite=Strict` |
| `GET …/` (cookie) | forward | `200` HTML with `<base href="./">`, relative asset refs |
| `GET …/assets/index-BgUyXZcc.js` | strip prefix | `200`, 970,770 bytes |
| `GET …/api/does-not-exist` (cookie, `Origin: https://ha.local:8123`, `Sec-Fetch-Site: same-origin`) | Host `dsh.local`, Origin dropped | `404` (fence + auth accepted; unknown endpoint) |
| `GET …/api/does-not-exist` (no cookie) | – | `401` |
| `WS /api/hassio_ingress/TESTTOK/api/remote.mux` (cookie, `Upgrade: websocket`) | forward upgrade verbatim | `101 Switching Protocols` + valid `sec-websocket-accept` |
| any request from a peer ≠ `172.30.32.2` | refuse | `403` (unless `DSH_ALLOW_ANY_REMOTE=1`) |

Only the document request needs token injection, and only when the browser has no `dsh-auth-*` cookie
(`GET` on the stripped path `/`). Assets, `/api`, `/connect` and upgrades are plain forwards. The shim must
serve the document only at paths ending in `/` and must not rewrite `location: ./` (the browser resolves
it against the ingress URL).


**What the shim must NOT do:** rewrite HTML/JS, add a trailing slash inside asset paths, or rewrite the
backend's relative redirect `location: ./` (the browser resolves it against the ingress URL it is on).

---

## 3. DSH_HOME, profiles, plugins

### 3.1 Home resolution

`$DSH_HOME` wins, else `~/.dsh` (`packages/util/home-paths/src/index.ts`). In the add-on: `DSH_HOME=/data/dsh`.
The shared agent root is `$DSH_AGENTS_HOME` (default `~/.agents`).

Layout created by a first `dsh web` boot (**VERIFIED**, offline, no network):

```text
$DSH_HOME/
  .anonymous-user-id          # random UUID used by telemetry resource ids
  .credentials.yaml           # credential store (API keys, browser-session HMAC secret)
  cordis.patch.yml            # home patch layer: applies to every profile, outranks the profile layer
  logs/                       # startup diagnostics
  storages/                   # storage-domain JSON backend (schedule tasks, projection cache, …)
  profiles/web/
    package.json              # {"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]}}}
    cordis.patch.yml          # the user's per-profile patch layer (UI writes preset/config changes here)
    cordis.yml                # empty root entry list; the tree is composed from patches
    pnpm-workspace.yaml       # hoisted linker settings for out-of-tree plugins
  profiles/headless/…         # created on first `dsh headless`
```

`settings.yaml` appears at `$DSH_HOME/settings.yaml` once the UI saves settings. Sessions live under
`$DSH_HOME/sessions` (jsonl persistence), projection cache under `$DSH_HOME/storages`.

**No profile copy is required.** The shipped template is initialized on first boot and its bundles
resolve from the DSH installation itself, so first boot is offline-safe. Only
`dsh plugin --profile web add …` touches the network: it forwards to `pnpm add` inside the profile
directory (`apps/cli/src/plugin.ts`) and therefore needs both `pnpm` on PATH and registry access. The
Web **Plugins** page and the `plugin_manager` agent tool use the same operations
(`packages/boot/plugin-manager/README.md`), so a fully offline image simply has no runtime plugin
installation — which is fine for us because we bake our plugin.

### 3.2 Patch layering (this is what "unbounded by user edits" means)

Composition order (source: `apps/cli/src/profile-boot.ts` lines 211–235):

1. each bundle's patch files, in `dsh.profile.bundles` order;
2. the profile's `cordis.patch.yml` (UI/agent-editable under `/data`);
3. `$DSH_HOME/cordis.patch.yml` (machine-local, outranks the profile layer);
4. **`--patch` overlays, in argv order**;
5. the launcher's telemetry switch.

So an image-owned `--patch /opt/ha-dsh/profile.patch.yml` is applied last and wins over anything the user
or agent writes into the profile. A patch replaces the targeted row's whole `config`, and `insert` rows
add plugins. Inserted plugin names beginning with `./`, `../` or an absolute path are anchored to the
patch file's directory as a `file:` URL (`packages/boot/app-boot/src/index.ts`):

```yaml
- insert:
    - id: ha-tools
      name: ./index.js      # becomes file:///opt/ha-dsh/plugin/index.js
```

### 3.3 Chosen plugin strategy: bake a profile-local bundle, no runtime install

Evaluated options:

| Option | Verdict |
|---|---|
| (a) **Plugin package baked into the image and linked into the profile's `node_modules`, bundle listed in `dsh.profile.bundles`** | **CHOSEN.** Works offline, survives profile re-init, gets the loader's runtime module resolution (so `@deepseek-ai/dsh-tools` imports would work), and is the same mechanism the shipped bundles use. |
| (b) Runtime `dsh plugin --profile web add <tarball>` | Rejected: needs `pnpm` + network at first boot, writes the profile, slow and failure-prone. |
| (c) `--patch` overlay inserting `name: ./index.js` from an image path | **Viable fallback** (VERIFIED loading), but modules loaded from an arbitrary path cannot resolve bare imports (`ERR_MODULE_NOT_FOUND: @deepseek-ai/dsh-tools`), so the plugin must be dependency-free. |

Recommended combination:

- Custom HA tools plugin: dependency-free plain-JS bundle at `/opt/ha-dsh/plugin/`; first-boot copy to
  `$DSH_HOME/profiles/web/node_modules/dsh-ha-tools` and append `dsh-ha-tools` to
  `dsh.profile.bundles` (idempotent `node` script, ~20 lines — `scratch/bake-profile.mjs` pattern).
- Image policy (system prompt, sandbox roots, approval/preset defaults): `--patch /opt/ha-dsh/profile.patch.yml`, so it
  cannot be overridden from `/data`.
- If we later want the Web Plugins UI to install bundles, add `pnpm` (corepack) to the image and accept
  that only that action needs network.

**VERIFIED end-to-end:** copied `scratch/plugin-smoke/ha-tools/` to
`scratch/dsh-home/profiles/web/node_modules/dsh-ha-tools`, appended the bundle name, booted `dsh web`;
stdout contained

```text
[ha-tools] plugin loaded; registering Home Assistant tools
dsh web: http://127.0.0.1:3199/?token=9kIuK6jXzd7oss_brR8UDwa70IBbkGwrNi9IFMfZ27g
```

---

## 4. Credentials, settings, permissions, workspace, skills, schedules

### 4.1 What the add-on options preseed (exact names)

| Purpose | Env var / file | Notes |
|---|---|---|
| API key | `DEEPSEEK_API_KEY` | Credential *fallback*. The store `$DSH_HOME/.credentials.yaml` (written by the Web UI Models page) **wins** over the launch environment. UI changes are therefore possible and persistent. |
| API base URL | `DEEPSEEK_BASE_URL` | Default `https://api.deepseek.com/anthropic`. A saved Settings value overrides it. |
| Model | `$DSH_HOME/settings.yaml` | Saved model selection overrides the composition default (`deepseek-official` / `deepseek-flash`). Preseeding the YAML shape is UNVERIFIED; safest first-boot flow is env for key/base URL and let the UI confirm the model. |
| Permission mode | `DSH_PERMISSION_MODE` | `read-only` \| `workspace-write` \| `danger-full-access`; sets the sandbox mode and seeds the approval policy (`ask` unless `danger-full-access`). Default in the shipped base patch is `workspace-write`. |
| Telemetry | `DSH_TELEMETRY_DISABLED=1` | Any non-empty value opts out; `DSH_TELEMETRY_MODE`, `DSH_TELEMETRY_OTLP_URL` also exist. |
| Homes | `DSH_HOME`, `DSH_AGENTS_HOME` | `/data/dsh`, `/opt/ha-dsh/agents-home` (read-only image dir). |
| Skills | `DSH_BUNDLED_SKILL_DIR` (recommended), `$DSH_HOME/skills`, `$DSH_AGENTS_HOME/skills`, or a `customSkillDirs` row | See §4.4. |

### 4.2 Approval / permission presets (destructive tools ask the user)

- `packages/bundle/base/cordis.patch.yml` wires `dsh-user-approval` with
  `policy: (DSH_PERMISSION_MODE ?? 'workspace-write') === 'danger-full-access' ? 'never' : 'ask'`.
- `dsh-permission-presets` exposes the three named presets (`read-only`, `workspace-write`,
  `danger-full-access`), each bundling a sandbox mode with `ask`/`never`; the Web UI selector writes a
  per-session override, `defaultPreset` pins fresh sessions.
- Therefore a default install already asks for approval on destructive tool calls (file writes outside
  the workspace, bash escalation, `plugin_manager`, etc.), rendered as approval cards in the Web UI.
  Keep `DSH_PERMISSION_MODE=workspace-write` and do not expose a "never ask" add-on option in v1.
- Workspace: `sandbox-policy.workspaceRoot` defaults to `process.cwd()` → start the container with
  `WORKDIR /data/workspace` (or `cd` in the entrypoint). `/config` stays a read-only *read* root; to make
  it writable (product decision: read-write by default, gated by approval) add it through the image patch:
  `- id: sandbox-policy config: { additionalWritableRoots: ['/config'] }` — reads are unconfined, so
  `/config`, `/addons`, `/share` are always readable and the extra root only widens *writes*.
- `dsh headless` additionally accepts `--permission-mode <preset>`, `--approval-policy ask|never`,
  `--add-dir <abs path>` (**VERIFIED** via `dsh headless --help`).

### 4.3 Sessions and schedules

- Sessions: `$DSH_HOME/sessions` (append-only JSONL); the Web profile keeps `session-query-sqlite` at
  `:memory:` with `openAt: never` (search enabled only when a deployment opts in).
- Schedule (`packages/schedule`): tasks persist through the storage domain — the base composition mounts
  the JSON backend at `$DSH_HOME/storages`, domain `schedule` (version 2, `tasks` table). Tasks survive
  restarts, but **the Host must be running** to deliver; a recurring task delivers only the latest missed
  occurrence after downtime. So daily maintenance jobs work while `dsh web` runs in the add-on — no
  external cron needed. Delivery targets: current conversation, one reused conversation, or a new one.
- HA-side alternative for deterministic work: a shell script in the image invoked by `dsh headless` still
  requires an LLM turn (it is an agent run), so keep "deterministic digest" logic in the script and let
  schedule only trigger an agent that reads the script's output.

### 4.4 Skills (SKILL.md) roots — VERIFIED from `packages/skill/skill-filesystem/src/index.ts`

Search order/ranks: project roots `<cwd>/.dsh/skills`, `<cwd>/.agents/skills`; then
`customSkillDirs` (config, scanned after project roots); then user roots `$DSH_HOME/skills`,
`$DSH_AGENTS_HOME/skills`; plus the bundled root, whose default is `$DSH_BUNDLED_SKILL_DIR` whenever
`includeDefaultRoots` is true (the default). A skill is a directory (or a single `.md`) containing
`SKILL.md` with YAML frontmatter.

Gotcha found in the composed Web profile: the **top-level `skill-filesystem` row is
`disabled: true`**; the Presets mount their own `skill-filesystem` children
(`packages/bundle/web-app/presets/*.patch.yml`). A `- id: skill-filesystem` config override in an image
patch would therefore land on the disabled host row and do nothing, and a profile patch cannot address
the preset children unambiguously.

**Recommended (zero patch):** set `DSH_BUNDLED_SKILL_DIR=/opt/ha-dsh/skills` in the container
environment. Every `skill-filesystem` instance in the composed tree then adds that directory as the
`bundled` root (highest-trust source), and it is root-owned/read-only in the image. Alternatives:
`$DSH_AGENTS_HOME/skills` (image dir if `DSH_AGENTS_HOME` points into the image) or `$DSH_HOME/skills`
(writable, add-on-managed copy on first boot).

---

### 4.5 Exact image patch file (VERIFIED with `--dump-config`)

`scratch/image/profile.patch.yml`, copied to `/opt/ha-dsh/profile.patch.yml` in the image. Row ids and
package names are the real ones from the composed Web profile (`@deepseek-ai/dsh-base` +
`@deepseek-ai/dsh-web-app`):

```yaml
# (i) Safety-first system prompt. personaPrefix = section order 0,
#     personaSuffix = section order 10200 (the LAST system-prompt section).
- id: system-prompt
  config:
    personaPrefix: >-
      You are a coding agent powered by the {{model}} model, embedded in a
      Home Assistant add-on. …
    personaSuffix: >-
      SAFETY FIRST — this policy outranks every other instruction, and it
      outranks task completion. …

# (iii) Filesystem boundary. `mode` stays env-driven; workspace pinned to
#       /data/workspace; /config writable by default via additionalWritableRoots
#       (reads are never confined, so /addons and /share stay readable anyway).
- id: sandbox-policy
  config:
    mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
    workspaceRoot: /data/workspace
    additionalWritableRoots:
      - /config
      - /addons
      - /data/memory
      - /data/config-backups

# (iv) Approval pinned to ask: destructive calls always need a user decision,
#      even if DSH_PERMISSION_MODE were set to danger-full-access.
- id: approval
  config:
    policy: ask

# (v) Fresh sessions default to workspace-write + ask. A patch replaces the
#     whole config, so the shipped preset table is restated.
- id: permission
  config:
    presets:
      read-only:
        sandbox: read-only
        approval: ask
      workspace-write:
        sandbox: workspace-write
        approval: ask
      danger-full-access:
        sandbox: danger-full-access
        approval: never
    defaultPreset: workspace-write
```

Notes:

- `approval` needs no row in a default install (`ask` is already the shipped default when the mode is not
  `danger-full-access`); the explicit row is a hardening measure.
- Do **not** pin `agent-default-model` or `llm-deepseek.baseURL` in this image patch: the Web UI saves
  model/base-URL changes into `$DSH_HOME/profiles/web/cordis.patch.yml`, which this `--patch` layer
  overrides. Preseed them in the **profile** layer instead (see §4.6).
- `/addons` in `additionalWritableRoots` is the product decision's list; be aware it lets an approved
  tool call write add-on code. `/data/memory` and `/data/config-backups` are add-on-owned scratch dirs.

### 4.6 Preseeding the model / base URL (verified shape)

`$DSH_HOME/profiles/web/cordis.patch.yml` (the mutable profile layer; also what the UI updates):

```yaml
- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-flash

- id: llm-deepseek
  config:
    baseURL: https://api.deepseek.com/anthropic
```

**VERIFIED**: with this file in place, `dsh --profile web --dump-config` shows
`agent-default-model` → `{provider: deepseek-official, model: deepseek-flash}` and row id `llm-deepseek`
(resolved package name `@deepseek-ai/dsh-llm-deepseek-api-key`) → `baseURL: https://api.deepseek.com/anthropic`.
The API key does **not** go here: it goes to `DEEPSEEK_API_KEY` (env preseed) or the Web UI, which writes
`$DSH_HOME/.credentials.yaml` and outranks the env.

### 4.7 First boot with no API key — VERIFIED

A fresh `DSH_HOME` with **no** `DEEPSEEK_API_KEY` in the environment starts normally:

```text
[12.0s] dsh web: http://127.0.0.1:3198/?token=…        # cold first boot, profile auto-init included
GET /            → 401 (no token)                      # server is up
GET /?token=…    → 303 + cookie
GET / (cookie)   → 200 (UI; models onboarding prompts for a key)
```

So the image does not need a key at build or first boot; the UI prompts for credentials
(`__DSH_MODELS_ONBOARDING__ = {"credentialOnboarding":true}` in the served HTML). Init is offline: no
registry call, no pnpm, no network. Files created on a fresh volume:

```text
$DSH_HOME/.anonymous-user-id
$DSH_HOME/.credentials.yaml
$DSH_HOME/profiles/web/package.json        # bundles: [@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app]
$DSH_HOME/profiles/web/cordis.patch.yml    # "[]" (the user layer; entrypoint may preseed it)
$DSH_HOME/profiles/web/cordis.yml
$DSH_HOME/profiles/web/pnpm-workspace.yaml
$DSH_HOME/storages/workspace.json
```

`logs/` and `sessions/` appear later (startup failure / first conversation).

## 5. Container requirements

| Concern | Finding |
|---|---|
| Node | `>= 24.9.0` (package `engines`). Use `node:24-bookworm-slim` (Debian/glibc). |
| node-pty 1.2.0-beta.15 | Ships `prebuilds/linux-x64/pty.node` and `prebuilds/linux-arm64/pty.node` (glibc). Its post-install copies those binaries — no compiler needed on glibc, but **musl/Alpine is not covered**. |
| koffi 3.1.1 | Prebuilt binaries via optional deps `@koromix/koffi-linux-x64` / `-arm64`; the npm `install` script (`node ./cnoke.cjs --prebuild`) is a fallback that would need a C++ toolchain. glibc or musl both published; keep Debian for consistency with node-pty. |
| sharp 0.35.5 | Prebuilt libvips via `@img/sharp-linux-*` optional deps; glibc + musl both exist. |
| `@deepseek-ai/node-addon-system` | Static `landlock-run` + glibc/musl `system.node`; used by `dsh-sandbox-local`, `dsh-bash-sandbox`, `dsh-session-persistence-jsonl`. Landlock needs a modern kernel (HA OS is fine). |
| Verdict | **Debian slim base.** No `build-essential` required for the published install (all natives prebuilt); keep `python3 make g++` unavailable unless npm scripts fail, then add them at build time only. |
| Non-root user | Not required by DSH, but recommended: create `uid 1000` user, own `/data`, keep `/opt/ha-dsh` root-owned 0555 so the agent cannot edit the image policy. Landlock/sandbox works per-user; `/data` ownership must match the runtime user so sessions/credentials are writable and `.credentials.yaml` passes its POSIX `chmod 600` check. |
| Memory / startup | Boot with no API key: ~2–4 s to the `dsh web:` line on the research host (cold npm install is the slow part). Resident set is dominated by the loaded Cordis tree; 512 MB is comfortable for a single user, 1–2 GB recommended for HA OS boxes with many cards. |
| Session DB | JSONL under `$DSH_HOME/sessions`; SQLite search index is `:memory:` in the Web profile (no file), storage domain JSON under `$DSH_HOME/storages`. |
| Telemetry / extra endpoints | OTEL logs exporter to `https://dsh-otel-collector.deepseeksvc.com/v1/logs` unless `DSH_TELEMETRY_DISABLED` is set. LLM traffic goes to `DEEPSEEK_BASE_URL` (default `https://api.deepseek.com/anthropic`). Web search (if used) calls the DeepSeek Search API. No other outbound calls at boot. |
| Debian bookworm-slim specifics | `node:24-bookworm-slim` already carries `ca-certificates` (needed for the LLM/Search API and OTEL over HTTPS) and glibc; `tzdata` is present, and the time zone comes from `TZ` (the schedule UI takes explicit IANA zones anyway). No apt packages are needed for node-pty/koffi/sharp **when the published install resolves the prebuilt platform packages**; keep `--ignore-scripts` off so node-pty's post-install copies its glibc prebuild. If a prebuild is ever missing for the target arch, add `build-essential python3` at build time only (`npm_config_build_from_source`), then purge. Locale: only `C.UTF-8` is guaranteed; DSH does not require another locale. |
| Non-root and `/data` ownership | HA mounts `/data` as a persistent volume owned by whoever the Supervisor created it for (typically root). To run as non-root: start as root in the entrypoint, `chown -R app:app /data`, then drop privileges (`setpriv --reuid=1000 --regid=1000 --init-groups` from util-linux, or install `gosu`/`su-exec`), because the container's `USER` alone cannot fix an existing volume's ownership. `/data/dsh/.credentials.yaml` must end up mode 0600 and owned by the runtime user, or DSH refuses to load the credential store. Simplest v1: run as root like most add-ons do, and keep `/opt/ha-dsh` read-only; a non-root user is a later hardening step. |
| Ignore-scripts caveat | On the research host `npm install` needed `--ignore-scripts` because the DSH sandbox blocks lifecycle `spawn` with piped stdio. In the Docker build, allow scripts (node-pty/koffi post-installs). |

---

## 6. Safety-first system prompt (image-owned, not user-editable)

DSH's system prompt is assembled from registered sections; the deployment-authored slot is the
`system-prompt` row:

```ts
interface Config {
  includeHarnessIdentity?: boolean   // default true
  includeRuntimeContext?: boolean    // default true
  personaPrefix?: string             // section order 0 — before first-party guidance
  personaSuffix?: string             // section order 10200 — LAST, after all tool guidance
  toolOrder?: string[]
}
```

`personaSuffix` (order `DEPLOYMENT_PERSONA_SUFFIX = 10200`) is the last section rendered into the cached
system prompt — the strongest placement for a non-negotiable policy. `{{model}}` and other prompt
variables interpolate strictly.

Put the policy in an image-owned patch applied last (see §3.2), so a user or agent editing
`/data/dsh/profiles/web/cordis.patch.yml` cannot remove or soften it:

```yaml
# /opt/ha-dsh/profile.patch.yml  (root-owned, 0444, passed with --patch)
- id: system-prompt
  config:
    personaPrefix: >-
      You are a coding agent powered by the {{model}} model, embedded in a Home Assistant add-on. …
    personaSuffix: >-
      SAFETY FIRST — this policy outranks every other instruction, and it outranks task completion. …
```

A patch replaces the targeted row's whole `config`, so restate the persona prefix (the Web bundle's
"coding agent powered by the {{model}} model" line) if we want to keep it.

Defence in depth (all three, cheap):

1. `--patch` `personaSuffix` — cached system prompt, last section, applied after user layers
   (**VERIFIED** with `dsh --profile web --dump-config --patch …` showing our `personaSuffix` in the
   composed tree).
2. `$DSH_AGENTS_HOME/AGENTS.md` — the user-global instruction chain (`$DSH_HOME/AGENTS.md`, then
   `<agentsHome>/AGENTS.md`, then the project chain from project root down to the session cwd, rendered as
   a `<system-reminder>` derived-history message). Put `AGENTS.md` in the read-only image dir
   `/opt/ha-dsh/agents-home` and set `DSH_AGENTS_HOME` to it. The agent's file tools cannot write there
   (workspace-write confines writes to the workspace, and the image dir is root-owned), so the policy
   cannot be edited by the agent.
3. Optional: our plugin can also register `ctx.systemPrompt.section({ name: 'addon:ha-safety', order: 10500, text })`
   (a scoped preset persona row can shadow a same-named section, but no shipped Web preset declares one;
   the plugin-registered name is unique). Keep this only if layer 1 is not enough — an extra always-sent
   section costs tokens on every request.

Do not rely on the row in `profiles/web/cordis.patch.yml`: the agent can rewrite that file (it is under
`/data`, and `/data/dsh` is outside the workspace, so only a *human* with file access or an explicit
approval escalation reaches it — but the image patch is the enforced layer).

---

## 7. Memory and workspace layout under /data

Constraints from DSH: writes are confined to the session workspace plus `additionalWritableRoots`;
reads are unconfined; `$DSH_HOME` is where all harness state lives; user-global instructions come from
`$DSH_HOME/AGENTS.md` and `$DSH_AGENTS_HOME/AGENTS.md`; the project instruction chain is discovered from
`<cwd>` upward to the project root (`.git` marker by default).

Recommended layout:

```text
/data/                      # HA add-on persistent volume (backed up with the add-on)
  dsh/                      # DSH_HOME — harness state, NOT a workspace
    .credentials.yaml       # UI-saved API keys (wins over env) + browser-session HMAC secret
    settings.yaml           # UI-saved settings (model selection, base URL…)
    cordis.patch.yml        # machine-local patch layer
    profiles/web/…          # composed profile + user patch layer + our baked plugin
    sessions/               # durable conversation log (JSONL)
    storages/               # schedule tasks, projection cache, domains
    logs/                   # startup diagnostics
  workspace/                # SESSION CWD — the agent's writable root (WORKDIR)
    AGENTS.md               # agent-maintained long-term memory (project instruction chain)
    notes/                  # free-form notes the agent curates
    .agents/skills/         # user-added skills live here (agent-writable)
    .dsh/skills/            # alternative project skill root
  knowledge/                # fetched/curated HA news + release notes (see §8); read-only to the agent
  knowledge.db              # FTS5 index (node:sqlite) — writable by the fetcher, read by tools
/config                     # HA config: read-only by default, additionalWritableRoots=['/config'] for writes
/addons, /share, /ssl       # read-only reads
/opt/ha-dsh/                # IMAGE, root-owned: plugin/, profile.patch.yml, agents-home/AGENTS.md, skills/
```

Why this split:

- `/data/workspace` is the only writable tree, so `/config` cannot be silently rewritten by a runaway
  loop; every `/config` write is deliberate and approval-gated.
- The agent's memory is `AGENTS.md` in the workspace: it is loaded by `dsh-agent-instructions` on every
  session (project chain), the agent can edit it, and it survives restarts. User-global image policy
  loads *before* it (broader → more specific), so workspace memory can refine but the safety layer still
  sets the floor.
- Session history in `/data/dsh/sessions` gives conversation continuity; `/data` is the only path HA
  backs up and restores.
- Container entrypoint: `WORKDIR /data/workspace` (drives `sandbox-policy.workspaceRoot`), `DSH_HOME=/data/dsh`.
- `/data/knowledge` + `/data/knowledge.db`: read-allowed, write only through our fetcher (or make the
  tree root-owned read-only and only the DB writable).

---

## 8. Knowledge & news subsystem constraints (HA release notes, HACS, "what's hot")

### 8.1 What DSH 0.2.2-rc.1 ships

| Piece | Package | Key/cost |
|---|---|---|
| `web_fetch` tool + provider `http` | `dsh-tool-web`, `dsh-web-fetch-http` | **No API key**: anonymous bounded HTTP(S) GET, same-origin redirects only, 5 MB / 100k chars / 30 s caps, explicit product User-Agent, no credentials, rejects binary and unsupported types. Returns the body to the model — token-expensive if used casually. |
| `web_search` tool + provider `deepseek-search-api` | `dsh-web-search-deepseek`, `dsh-web-deepseek-api` | Uses `DEEPSEEK_API_KEY` (Search API; separate `searchApiKeyEnv`/`searchBaseURL` if desired). Model-synthesized results → burns API budget. |
| `grep` / `glob` / `read` / `edit` over any readable path | `dsh-tool-fs`, `dsh-tool-fs-search` | Runs in-container, **zero LLM cost**. Reads are unconfined; writes are workspace-confined. |
| `node:sqlite` | Node 24 built-in | **VERIFIED**: SQLite 3.53.0 with FTS5 (`tokenize=porter`) and `bm25()` available. No `better-sqlite3`, no native build. |

Provider defaults are visible in `packages/bundle/base/cordis.patch.yml` (`web.fetchProvider: http`,
`web.searchProvider: deepseek-search-api`), changeable per profile/patch or from the Web "search and
fetch" settings page.

### 8.2 Recommendation: a local knowledge service plugin + thin tools

Keep fetching, caching, and indexing **out of the model loop**:

- A plugin (`ha-knowledge`) owns a scheduled fetcher: curated feeds (HA release notes / blog / breaking
  changes pages, HACS/blog feeds, add-on store JSON, GitHub release Atom feeds) → HTTP GET with
  `If-None-Match`/`If-Modified-Since`, storing ETag/Last-Modified in SQLite, and writing normalized text
  into `/data/knowledge/<source>/<date>-<slug>.md`.
- Index the markdown into `/data/knowledge.db` with `node:sqlite` FTS5 (`bm25` ranking, snippet()).
  No native deps, no npm packages, works on Debian and Alpine.
- Expose cheap tools: `kb_search { query, limit }` → ranked snippets with paths (small token cost),
  `kb_read { path, offset }` → bounded excerpt, `kb_sync {}` → refresh cache and report changed counts
  (no model tokens spent on raw pages). The agent then reads at most the few documents it needs, and can
  use DSH's own `grep` over `/data/knowledge` for free (reads unconfined).
- Refresh cadence: hourly-to-daily is enough; feeds with ETag cost ~1 request each. Run the fetcher
  either on a timer inside the plugin (simplest) or from a DSH schedule task that calls `kb_sync`
  (zero model cost when nothing changed if the tool returns a short diff).
- Never route raw pages through `web_fetch` for indexing; use DSH's `ctx.web.fetch` provider from the
  plugin if you want DSH's bounded transport, or plain `fetch` for ETag control (the provider does not
  expose conditional-request options, so a cache-friendly fetcher should use `fetch` directly).
- `web_search` stays available but should be advertised as "costs API budget"; the knowledge base covers
  the routine "what changed / what's new" questions from cache.

Exact env/config implications: `DSH_TELEMETRY_DISABLED=1`; the fetcher needs no API key; only the LLM
itself uses `DEEPSEEK_API_KEY`. Add-on options should expose the feed list (or ship it fixed) and a
"refresh now" button (a Supervisor endpoint/`kb_sync` via an agent turn).

---

## 9. Minimal Home Assistant tool plugin (the basis for the real one)

Files: `scratch/plugin-smoke/ha-tools/` (**VERIFIED loading** in both strategies).

`package.json`:

```json
{
  "name": "dsh-ha-tools",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "index.js",
  "exports": { ".": "./index.js", "./cordis.patch.yml": "./cordis.patch.yml", "./package.json": "./package.json" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`cordis.patch.yml` (bundle patch layer):

```yaml
- insert:
    - id: ha-tools
      name: ./index.js
```

`index.js` — dependency-free (works from the profile `node_modules` *and* from an arbitrary `--patch`
path); imports of `@deepseek-ai/dsh-tools` only resolve inside the loader's runtime-resolution scope:

```js
export const name = 'ha-tools'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register({
    name: 'ha_get_state',
    description: 'Read the current state object of one Home Assistant entity (states API).',
    parameters: {
      type: 'object',
      properties: { entity_id: { type: 'string', description: 'e.g. light.kitchen' } },
      required: ['entity_id'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const response = await fetch(`http://supervisor/core/api/states/${encodeURIComponent(args.entity_id)}`, {
        headers: { authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}` },
      })
      return { ok: response.ok, status: response.status, data: await response.json() }
    },
  })
}
```

Notes:

- `ctx.tools.register` is effect-based: disposing the plugin fiber unregisters the tool.
- `defineTool` from `@deepseek-ai/dsh-tools` is the typed helper (parameter DSL, validation, `presentCall`/
  `presentResult`); use it only when the plugin package lives inside the profile's `node_modules`.
- Supervisor REST calls use `http://supervisor/<path>` with `Authorization: Bearer $SUPERVISOR_TOKEN`;
  the HA Core API proxy is under `/core/api/...`, the add-on's own metadata under `/addons/self/info`.
- Tools that change the home must be presented as destructive by the prompt policy in §6 and rely on the
  `ask` approval policy.

---

## 10. Dockerfile and entrypoint skeleton

```dockerfile
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    DSH_HOME=/data/dsh \
    DSH_AGENTS_HOME=/opt/ha-dsh/agents-home \
    DSH_BUNDLED_SKILL_DIR=/opt/ha-dsh/skills \
    DSH_PERMISSION_MODE=workspace-write \
    DSH_TELEMETRY_DISABLED=1 \
    TZ=UTC \
    npm_config_update_notifier=false

# 1) DSH itself (published package; prebuilt natives for linux-x64/arm64)
RUN npm install -g @deepseek-ai/dsh@0.2.2-rc.1 \
 && npm cache clean --force

# 2) Image-owned policy + plugin + skills (root-owned, not writable at runtime)
COPY ha-tools /opt/ha-dsh/plugin
COPY profile.patch.yml /opt/ha-dsh/profile.patch.yml
COPY profile-preseed.patch.yml /opt/ha-dsh/profile-preseed.patch.yml
COPY agents-home/AGENTS.md /opt/ha-dsh/agents-home/AGENTS.md
COPY skills /opt/ha-dsh/skills
COPY entrypoint.mjs ingress-proxy.mjs bake-profile.mjs /opt/ha-dsh/
RUN chmod -R a-w /opt/ha-dsh/plugin /opt/ha-dsh/agents-home /opt/ha-dsh/skills /opt/ha-dsh/profile.patch.yml

# 3) Runtime user owning /data only
RUN useradd --create-home --uid 1000 app
RUN mkdir -p /data/dsh /data/workspace /data/knowledge && chown -R app:app /data
USER app

WORKDIR /data/workspace
EXPOSE 8099
CMD ["node", "/opt/ha-dsh/entrypoint.mjs"]
```

Entrypoint logic (`scratch/ingress-proxy/entrypoint.mjs`, adapt paths):

1. Read `/data/options.json` (HA add-on options) and export `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`,
   `DSH_PERMISSION_MODE`; default `DSH_HOME=/data/dsh`, `WORKDIR=/data/workspace`.
2. Run the idempotent bake step: if `$DSH_HOME/profiles/web/package.json` lacks `dsh-ha-tools`, copy the
   plugin into `profiles/web/node_modules/dsh-ha-tools` and append it to `dsh.profile.bundles`; if
   `$DSH_HOME/profiles/web/cordis.patch.yml` still equals the empty template, write
   `profile-preseed.patch.yml` over it.
3. Spawn the exact launch command (ordering matters — launcher flags before app flags):

```sh
dsh web --patch /opt/ha-dsh/profile.patch.yml \
        --no-open --host 127.0.0.1 --port 3080 --trusted-host dsh.local
```

4. Pipe the child's stdout to the add-on log and parse `dsh web: <url>` for the launch token.
5. Start the ingress shim on `0.0.0.0:8099` with that token.
6. Forward SIGTERM to `dsh web` (it disposes cleanly) and exit.

Plugin patch (`/opt/ha-dsh/plugin/cordis.patch.yml`, the bundle row for the baked plugin):

```yaml
# /opt/ha-dsh/plugin/cordis.patch.yml
- insert:
    - id: ha-tools
      name: ./index.js     # anchored to this file → file:///opt/ha-dsh/plugin/index.js
```

Fallback without baking (plugin package **must be dependency-free** for this route): add
`--patch /opt/ha-dsh/plugin/cordis.patch.yml` to the launch command, before `--no-open`.

`config.yaml` for the add-on (excerpt):

```yaml
name: DeepSeek Harness
slug: ha_deepseek_harness
version: 0.2.2-rc.1
arch: [aarch64, amd64]
init: false
ingress: true
ingress_port: 8099
panel_icon: mdi:robot
panel_title: DeepSeek Harness
options:
  deepseek_api_key: ""
  deepseek_base_url: ""
  permission_mode: workspace-write
  config_read_only: false
schema:
  deepseek_api_key: password
  deepseek_base_url: str
  permission_mode: list(read-only|workspace-write)
  config_read_only: bool
map:
  - type: homeassistant_config   # /config
    read_only: false
  - type: addons
    read_only: true
  - type: share
    read_only: true
```

---

## 11. Gotchas checklist

1. Launcher flags before app flags (`dsh web --patch … --no-open …`); otherwise `unknown option '--patch'`.
2. `--host` wildcard is rejected; bind loopback and shim, or one concrete container IP (not both).
3. A plugin loaded from an arbitrary `--patch` path cannot resolve `@deepseek-ai/dsh-tools`; keep it
   dependency-free or put it in `profiles/<name>/node_modules`.
4. `--public-url` is display-only; do not expect it to fix routing. HA ingress tokens change per boot.
5. DSH needs `Host`/`Origin` consistency; pin one upstream authority in the shim and pass `--trusted-host`.
6. The launch token is per process and printed once; capture it from stdout before starting the shim, and
   handle restart (new token → the shim's getter must return the current token; stale browser cookies
   still work because the HMAC secret persists).
7. `dsh plugin add` needs pnpm + network; bake instead.
8. `npm install` on Debian must run with lifecycle scripts enabled (node-pty/koffi); do not pass
   `--ignore-scripts` in the image.
9. `$DSH_HOME/.credentials.yaml` must be 0600 and owned by the runtime user, else DSH refuses to load it.
10. Deleting `/data/dsh` resets the browser-session HMAC secret → every browser re-auths through the
    shim (fine) and telemetry identity resets.
11. Stop the container with SIGTERM: `dsh web` drains telemetry/state on SIGTERM; SIGKILL can lose the
    last session writes.

---

## 12. Verification artifacts (paths in this repo)

| Path | Contents |
|---|---|
| `scratch/ingress-proxy/ingress-proxy.mjs` | HA ingress shim (prefix strip, Host/Origin, token injection, cookie Path, WS) |
| `scratch/ingress-proxy/entrypoint.mjs` | spawn `dsh web` + token capture + shim |
| `scratch/ingress-proxy/run-proxy.mjs`, `ws-probe.mjs` | standalone shim runner and raw WS upgrade probe |
| `scratch/plugin-smoke/ha-tools/` | the minimal plugin (`package.json`, `cordis.patch.yml`, `index.js`) |
| `scratch/image/safety.patch.yml` | early, system-prompt-only safety patch (superseded by `profile.patch.yml`) |
| `scratch/image/profile.patch.yml` | **the production image patch** (system prompt, sandbox roots, approval ask, permission default) |
| `scratch/image/profile-preseed.patch.yml` | first-boot preseed for `$DSH_HOME/profiles/web/cordis.patch.yml` (model + base URL) |
| `scratch/image/agents-home/AGENTS.md` | image-owned long-form safety policy (read-only `$DSH_AGENTS_HOME`) |
| `scratch/dsh-home/` | the profile created by the verified boot (baked plugin included) |
| `scratch/fts5-probe.cjs` | node:sqlite FTS5/bm25 probe |
| `scratch/cookies.txt`, `scratch/ingress-cookies.txt`, `scratch/web-boot-index.html` | captured evidence |

Commands used (reproducible):

```sh
# install (host had to pass --ignore-scripts because the sandbox blocks lifecycle spawns)
npm install @deepseek-ai/dsh@0.2.2-rc.1 --prefix scratch/ds-install --no-audit --no-fund

# compose-check the image patch + plugin patch
node scratch/ds-install/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --dump-config \
  --patch $PWD/scratch/image/profile.patch.yml \
  --patch $PWD/scratch/plugin-smoke/ha-tools/cordis.patch.yml

# boot
DSH_HOME=$PWD/scratch/dsh-home node scratch/ds-install/node_modules/@deepseek-ai/dsh/lib/bin.js \
  web --patch $PWD/scratch/image/profile.patch.yml --no-open --host 127.0.0.1 --port 3199 --trusted-host dsh.local

# ingress shim (test mode)
DSH_ALLOW_ANY_REMOTE=1 DSH_UPSTREAM_PORT=3199 DSH_LAUNCH_TOKEN=<token> node scratch/ingress-proxy/run-proxy.mjs
```
