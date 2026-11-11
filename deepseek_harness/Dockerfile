# syntax=docker/dockerfile:1
#
# DeepSeek Harness for Home Assistant — add-on image.
#
# Debian slim (glibc) is used deliberately: the DSH 0.2.2-rc.1 dependency tree
# ships glibc prebuilds for node-pty / koffi / sharp, so Alpine (musl) is not
# supported by upstream. The image installs DSH from npm at build time; the
# runtime is offline except for the configured LLM API.
FROM node:24-bookworm-slim

ARG BUILD_ARCH
ARG BUILD_VERSION
ARG DSH_VERSION=0.2.2-rc.1

# Home Assistant's Supervisor adds the io.hass.* labels itself. Do not repeat
# them here: a version-varying LABEL before the npm install would invalidate the
# cache layer and force a full 652-package reinstall on every add-on update.

ENV NODE_ENV=production \
    DSH_HOME=/data/dsh-home \
    DSH_TELEMETRY_DISABLED=1 \
    DSH_PERMISSION_MODE=workspace-write \
    DSH_BUNDLED_SKILL_DIR=/opt/ha-dsh/skills \
    DSH_WEB_PORT=3080 \
    DSH_INGRESS_PORT=8099

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      jq \
      tzdata \
 && rm -rf /var/lib/apt/lists/*

# Install DSH globally; the published package is self-contained (base + web app
# + frontend assets) and boot needs no network.
RUN npm install -g "@deepseek-ai/dsh@${DSH_VERSION}" \
 && npm cache clean --force \
 && dsh --version

# BUILD_VERSION changes on every release; keep it out of the cached npm layer so
# updates only rebuild the small rootfs layer instead of reinstalling 652 packages.
ENV DSH_ADDON_VERSION=${BUILD_VERSION}

COPY rootfs /

# The runtime entrypoint supervises three children: the DSH web server (bound to
# loopback), the ingress shim (port 8099) and the deterministic collector.
# The add-on runs as root inside its own container: Home Assistant exposes /data
# as a root-owned volume, and the confinement boundary is the container plus the
# AppArmor profile rather than an unprivileged UID.
RUN chmod +x /usr/local/bin/* \
 && mkdir -p /data/dsh-home /data/memory /data/monitor /data/knowledge

WORKDIR /data

# 8099 is the ingress port. It is not published: Supervisor reaches it over the
# internal add-on network and Home Assistant's proxy authenticates the user.
EXPOSE 8099
ENTRYPOINT ["node", "/opt/ha-dsh/runtime/entrypoint.mjs"]


