# Changelog

All notable changes to the DeepSeek Harness add-on are documented here. The
version matches `config.yaml`; Home Assistant only offers an update when this
file's top version changes.

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
