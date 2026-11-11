# Changelog

All notable changes to the DeepSeek Harness add-on are documented here. The
version matches `config.yaml`; Home Assistant only offers an update when this
file's top version changes.

## 0.1.25

- Repository rules: added root `AGENTS.md` with the release checklist and a hard
  rule that every published add-on version must have a matching top changelog
  entry and updated docs.
- `scripts/check-addon.mjs` now fails when the `config.yaml` version and the top
  `## x.y.z` changelog heading differ, so a version can no longer ship without a
  changelog entry.
- Restored the missing 0.1.8–0.1.24 entries below (they were lost to a
  line-ending bug in the release script and never reached the store UI).

## 0.1.24

- Fix: `DeepSeek Messages request failed (404)`. The add-on exported the
  `base_url` option verbatim, so the default `https://api.deepseek.com` made DSH
  call the wrong path. The default is now
  `https://api.deepseek.com/anthropic`; a bare `https://api.deepseek.com` is
  normalised to it, custom proxy URLs are left untouched.

## 0.1.23

- First-run analysis resets its failure counter when the API key appears or
  changes (credential fingerprint), so attempts made while no key was configured
  no longer block the first real analysis.

## 0.1.22

- Fix: the `configuration.yaml` key discovery accepts the short `api:` key name
  (in addition to `api_key`, `api-key`, `deepseek_api_key`, `key`, `token`,
  `password`). This is the form used on the test instance:

  ```yaml
  deepseekharness:
    api: sk-…
  ```

## 0.1.21

- `/__status` shows the (redacted) live `configuration.yaml`, its mtime and
  SHA-256, recently modified `/config` files and any YAML file that mentions
  `deepseek`, to diagnose edits made in the wrong file or not saved.

## 0.1.20

- First-run analysis retries on a later boot after a deterministic-only run (no
  key, disabled option or failed attempt): adding the API key and restarting the
  add-on is enough, no need to wipe `/data`.

## 0.1.19

- Verification release for the Docker cache: after 0.1.18 rebuilds the npm layer
  once, updates with unchanged files should not need a full DSH reinstall.

## 0.1.18

- Update speed: the Dockerfile no longer stamps version-varying `io.hass.*`
  labels before the dependency install (Supervisor adds them itself) and
  `DSH_ADDON_VERSION` is set after the npm layer, keeping the npm/apt cache
  valid across releases.
- Added `scripts/monitor-addon.mjs`: watches an add-on install/update through the
  Supervisor API and prints state/version transitions.

## 0.1.17

- Faster updates: `BUILD_VERSION` no longer invalidates the cached npm/apt
  layers, so an update only rebuilds the small rootfs layer instead of
  reinstalling the 652-package DSH tree.
- `/__status` reports whether a key was extracted from `configuration.yaml`, its
  length, and a redacted excerpt of the matching lines.

## 0.1.16

- Fix: key discovery also accepts the common underscore-less block form
  (`deepseekharness:`), the hyphenated form and inline mappings, plus
  `api-key`/`key` aliases.

## 0.1.15

- Diagnostics: `/__status` reports the top-level keys of
  `configuration.yaml` (names only).

## 0.1.14

- Diagnostics: `/__status` reports which mount paths exist (`/config`,
  `/homeassistant`, `/addons`, `/share`, `/ssl`), their entry counts, and whether
  `configuration.yaml` with a `deepseek_harness:` block is visible.

## 0.1.13

- API-key discovery logs its source and length (never the value): add-on
  options/environment or `/config/configuration.yaml`.
- The sidebar panel is enabled once per installation using a dedicated
  `/data/.panel-initialized` marker, so a fresh install always shows the sidebar
  entry.

## 0.1.12

- Fresh installs automatically enable the "DeepSeek Harness" sidebar panel when
  Supervisor left `ingress_panel` off (first-run only, so a user's later choice
  is respected).
- Key discovery runs after the data directory exists so its log line is
  preserved; first-run recognition logs into the add-on log, visible via
  `/__logs`.

## 0.1.11

- Fix: a stale `dsh-auth` cookie no longer traps the panel on the "starting"
  page. When the document request returns 401/403, the shim redirects through
  the current launch token so DSH issues a fresh cookie.

## 0.1.10

- Fix: the ingress shim no longer sends `Content-Length` together with
  `Transfer-Encoding` (and no longer proxies a compressed body into the buffered
  document). Supervisor rejected the malformed response with
  `400 Content-Length can't be present with Transfer-Encoding`, which surfaced
  as a blank panel / 502.

## 0.1.9

- Diagnostics: the ingress shim serves an authenticated `/__logs` endpoint with
  the add-on log tail (tokens and API keys redacted). The entrypoint mirrors its
  own messages into the add-on log.

## 0.1.8

- Install/first boot no longer blocks the UI: first-run recognition runs in the
  background after `dsh web` starts.
- DeepSeek API key is also read from `/config/configuration.yaml` when the
  add-on option and environment do not provide one.
- While DSH is starting or its launch token is not ready, the ingress shim shows
  a self-refreshing "starting" page instead of DSH's raw
  "authentication required; reopen the URL printed by dsh web" document.

## 0.1.7

- The first-run analysis session now opens once per browser even when that
  browser already has a saved DSH session selection (marked with
  `dsh.first-run-session`), instead of only in a fresh browser profile.

## 0.1.6

- First-run recognition: on the first start the add-on deterministically
  collects the inventory (Core/Supervisor/OS versions, host, integrations,
  entities, automations, apps, updates, backups, config files) and writes
  `FIRST-RUN.md` into the workspace (`/config/deepseek-harness`), without any
  model calls.
- When an API key is configured (add-on option or DSH UI credentials), one
  read-only `dsh headless` assessment runs and writes `FIRST-RUN-REPORT.md`; its
  persisted session is opened by default in the Web UI.
- New option `first_run_analysis` (default on) lets users skip the model
  assessment; the deterministic report is always written.

## 0.1.5

- Default agent workspace moved from `/data/workspace` to
  **`/config/deepseek-harness`**: files the agent creates are visible in the Home
  Assistant configuration folder and are included in Home Assistant's backups.

## 0.1.4

- Fix: plugin bundle URLs are also repaired in the form Home Assistant actually
  forwards (`plugins/??<id>/client.js=&rev=…`).

## 0.1.3

- Diagnostics build: the ingress shim can echo the URL it received under the
  `x-dsh-debug: 1` header (removed again in 0.1.4).

## 0.1.2

- Fix: DSH client plugin bundles load through Home Assistant ingress. HA
  Core/Supervisor re-encodes the `plugins/??<id>/client.js&rev=…` URL, which DSH
  does not match (404) — the shim restores the exact bundle key.

## 0.1.1

- Fix: `quiet_hours` schema now accepts an empty value as well as `HH:MM-HH:MM`
  (empty default previously failed Supervisor option validation, so the add-on
  refused to start).

## 0.1.0 — developer preview

- First public scaffold: DeepSeek Harness Web UI served through Home Assistant
  ingress (sidebar panel), running DSH from npm inside the add-on container.
- Native DSH plugin with Home Assistant Core, Supervisor, safe config-file,
  memory, monitoring, local knowledge/news, notification and add-on-builder
  tools.
- Persistent agent memory under `/data/memory` (deterministic system snapshot +
  curated notes), backup ledger and backup-age monitoring.
- Safety layer: permanent safety-first system prompt, read-only option, approval
  tokens for disruptive/destructive actions, deny-lists for dangerous services
  and paths.
- Deterministic collector for health probes, daily digest and stale-backup
  alerts; zero LLM calls in the collection path.
- Local knowledge cache for Home Assistant releases/breaking changes (fetched
  locally, no model tokens).
- Add-on builder: scaffold, validate, build and debug local apps in `/addons`.
