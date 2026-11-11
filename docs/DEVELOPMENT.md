# Development

## Layout

```
repository.yaml                 HA add-on repository manifest (required at repo root)
deepseek_harness/               the add-on
  config.yaml                   HA add-on manifest (ingress, API access, maps, options)
  Dockerfile                    node:24-bookworm-slim + npm-installed DSH
  icon.png / logo.png           store assets
  translations/en.yaml          option labels
  DOCS.md, README.md, CHANGELOG.md
  rootfs/
    opt/ha-dsh/
      lib/                      shared plain-ESM modules (no dependencies)
      plugin/                   DSH bundle: index.js + tools/*.js + cordis.patch.yml
      runtime/                  entrypoint.mjs, ingress-shim.mjs, collector.mjs
      profile.patch.yml         managed DSH overlay (safety prompt, sandbox, approval)
      prompts/AGENTS.md         managed operating context
      skills/                   4 SKILL.md playbooks (bundled skill root)
tests/
  plugin/                       node:test suites with mocked fetch
  runtime/                      ingress shim + entrypoint unit tests
docs/                           requirements, architecture, security, memory, research
```

The add-on image installs `@deepseek-ai/dsh@<pinned>` from npm. The plugin is
plain ESM with **no third-party imports** and is loaded from the image through a
`--patch` overlay; the DSH profile is auto-initialised on first boot under
`/data/dsh-home` (no profile copy, no `dsh plugin add`, no runtime npm/network).

## Prerequisites

- Node.js 24 (tests only; plain `node` works)
- Git, optionally Docker Desktop with a Linux engine for image builds
- Home Assistant OS for end-to-end testing (not available in CI)

## Run the tests

```sh
node --test tests/plugin          # tools, safety, memory, monitoring, builder
node --test tests/runtime         # ingress shim helpers, option mapping
node --check deepseek_harness/rootfs/opt/ha-dsh/runtime/entrypoint.mjs
```

No network and no Home Assistant are required: Supervisor calls are stubbed with
`globalThis.fetch` routers.

## Validate the add-on manifest

There is no official standalone linter; CI checks are:

```sh
node scripts/check-addon.mjs       # YAML sanity, required fields, referenced files
```

and, on a real HA OS box, add the repository and install the add-on.

## Boot DSH locally against the plugin (developer shortcut)

The published CLI can be exercised on a workstation:

```sh
npm install --no-save @deepseek-ai/dsh@0.2.2-rc.1
DSH_HOME="$PWD/scratch/dev-dsh-home" \
DSH_ADDON_VERSION=dev \
node node_modules/@deepseek-ai/dsh/bin/dsh.js web \
  --patch "$PWD/deepseek_harness/rootfs/opt/ha-dsh/profile.patch.yml" \
  --patch "$PWD/deepseek_harness/rootfs/opt/ha-dsh/plugin/cordis.patch.yml" \
  --no-open --host 127.0.0.1 --port 3199 --trusted-host dsh.local
```

Look for `[ha-deepseek-harness] registered N tools` in the output. Supervisor
tools will return `SUPERVISOR_TOKEN is not set` — use the mocks in tests for
behaviour. On Windows, adjust the sandbox paths in a copy of
`profile.patch.yml` or expect them to be ignored.

## Build the image

```sh
docker build --build-arg BUILD_VERSION=0.1.0 \
  --build-arg BUILD_ARCH=amd64 \
  -f deepseek_harness/Dockerfile deepseek_harness
```

For amd64 on an x86 host this is the fastest check. HA OS builds the same image
on the device from the repository URL (no `image:` key in `config.yaml`). For a
public release, publish a multi-arch image to GHCR and add `image:` matching
`version` exactly — see `docs/research/ha-addon.md` §6.2.

## Updating DSH

1. Bump `ARG DSH_VERSION` in `deepseek_harness/Dockerfile`.
2. Re-run the plugin tests; boot locally (above) and check plugin registration.
3. Bump `version` in `config.yaml` and `CHANGELOG.md`, commit, push.
4. On HA OS: reload the store, update the add-on. `/data` is preserved.

## Safety rules for contributions

- Never add a tool that can reach excluded surfaces (`.storage`, state writes,
  OS/datadisk, auth, protection mode, raw shell through HA services).
- Every mutating tool must carry an operation class, an option gate where
  relevant, and a confirmation-token flow for DIS/DES.
- New writes must be bounded, atomic, and recoverable; no unbounded lists, no
  full state dumps into model context.
- Keep the plugin dependency-free: relative imports inside `rootfs/opt/ha-dsh/`
  only, `node:` builtins otherwise.
- Update `docs/PLUGIN_SPEC.md`, the relevant SKILL.md, and the tests together.

## CI

`.github/workflows/validate.yml` (to be added with the first push): Node 24 test
run, YAML/manifest check, Dockerfile build for amd64. Publishing images uses the
Home Assistant builder actions described in `docs/research/ha-addon.md`.
