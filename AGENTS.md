# Repository instructions for coding agents

This repository ships a Home Assistant add-on. These rules are mandatory for any
change made by an agent (and reviewed for human contributions).

## Release checklist (every published version)

1. Bump `deepseek_harness/config.yaml` → `version`.
2. Add a matching **top** entry `## <version>` to
   `deepseek_harness/CHANGELOG.md` describing the user-visible change. The top
   changelog heading MUST equal the `config.yaml` version — the validator fails
   otherwise, because Home Assistant only offers an update when this changes.
3. Update the affected docs: `docs/INSTALL.md`, `deepseek_harness/DOCS.md`,
   `deepseek_harness/translations/en.yaml`, `docs/ARCHITECTURE.md`,
   `docs/SECURITY.md` — options, settings and paths must match the code.
4. Run all checks:
   ```sh
   node scripts/check-addon.mjs
   node tests/plugin/core.test.mjs
   node tests/plugin/state.test.mjs
   node tests/runtime/shim.test.mjs
   node tests/runtime/entrypoint.test.mjs
   ```
5. Commit and push `main`. After a push, reload the add-on store in HA
   (`POST /store/reload` through the Supervisor API) so the UI refreshes the
   version/changelog; the Supervisor panel caches store data and changelogs.

## Changelog rules

- Newest entry first; one `## x.y.z` heading per release; no unreleased versions
  in `config.yaml` without a changelog entry.
- Write user-facing language (what changed and why), not commit messages.
- Never rewrite or delete released entries; fix mistakes with a new version.

## Code rules

- The DSH plugin bundle (`rootfs/opt/ha-dsh/plugin`) must stay dependency-free:
  relative imports into `rootfs/opt/ha-dsh/lib` and `node:` builtins only.
- Every mutating tool needs an operation class (`lib/safety.js`), an option gate
  where relevant, and a confirmation-token flow for disruptive/destructive actions.
- Config-file writes go through `lib/config-files.js` (snapshot → atomic write →
  `check_config` → rollback). Never bypass it.
- The ingress shim is the only public listener; keep DSH on loopback, never add
  `ports`/`host_network`/`docker_api`/`privileged` to the manifest.
- Never log or commit secrets: API keys, tokens, `secrets.yaml` values, cookies.
  Diagnostics (`/__logs`, `/__status`) must redact them.
- Do not edit `upstream-dsh/` (research checkout) or commit `scratch/`.

## Verification expectations

- Unit tests must run offline (stub `fetch`/`WebSocket`); no HA or Docker needed.
- Anything that touches the manifest, versioning or startup must be validated
  with `scripts/check-addon.mjs`.
- On a real HA OS instance, verify at minimum: install from the repository URL,
  sidebar panel visible, Web UI loads (200), one read-only tool call, and an
  add-on update from the previous version.

## Repository layout (mental map)

```
repository.yaml                 HA add-on repository manifest
deepseek_harness/               add-on (config.yaml, Dockerfile, rootfs/, docs)
deepseek_harness/rootfs/opt/ha-dsh/
  lib/                          shared plain-ESM modules
  plugin/                       DSH bundle: index.js + tools/* + cordis.patch.yml
  runtime/                      entrypoint, ingress shim, collector, first-run
  profile.patch.yml             managed DSH overlay (safety prompt, sandbox)
  prompts/AGENTS.md             managed operating context for the runtime agent
  skills/                       SKILL.md playbooks
scripts/check-addon.mjs         manifest/plugin/skills/version validator
scripts/monitor-addon.mjs       Supervisor install/update monitor
tests/                          offline test suites
docs/                           requirements, architecture, security, memory, research
```
