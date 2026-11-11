# Changelog

All notable changes to the DeepSeek Harness add-on are documented here. The
version matches `config.yaml`; Home Assistant only offers an update when this
file's top version changes.

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
  read-only `dsh headless` assessment runs before the UI starts, writes
  `FIRST-RUN-REPORT.md`, and its persisted session is opened by default in the
  Web UI (seeded through `dsh.sessions.current`, only when the browser has no
  saved selection).
- The ingress shim starts before the first-run analysis, so the Supervisor
  watchdog and panel stay reachable during the one-time boot extension.
- New option `first_run_analysis` (default on) lets users skip the model
  assessment; the deterministic report is always written.
- The first-run marker lives in `/data/first-run.json`; failures are retried at
  most three times and never block the add-on.

## 0.1.5

- Default agent workspace moved from `/data/workspace` to
  **`/config/deepseek-harness`**: files the agent creates are visible in the Home
  Assistant configuration folder and are included in Home Assistant's backups.
  The entrypoint creates the directory and DSH runs with it as its working
  directory; the sandbox workspace root points there as well.
- Docker image no longer creates or uses `/data/workspace`.

## 0.1.4

- Fix: plugin bundle URLs are also repaired in the form Home Assistant actually
  forwards (`plugins/??<id>/client.js=&rev=…` — an empty-value `=` injected by
  the proxy chain). With 0.1.2 only the percent-encoded variant was handled, so
  the UI still failed to load client plugins.

## 0.1.3

- Diagnostics build: the ingress shim can echo the URL it received under the
  `x-dsh-debug: 1` header (removed again in 0.1.4).

## 0.1.2

- Fix: DSH client plugin bundles now load through Home Assistant ingress. HA
  Core/Supervisor re-encodes the `plugins/??<id>/client.js&rev=…` URL into
  `/plugins/?%3F…=&rev=…`, which DSH does not match (404) — the shim restores
  the exact bundle key. Without this the UI showed "Failed to load plugins /
  HTML did not preload @deepseek-ai/dsh-client-modules/client.js".

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

















