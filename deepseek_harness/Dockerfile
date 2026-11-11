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

LABEL \
  io.hass.name="DeepSeek Harness" \
  io.hass.description="DeepSeek Harness agent for Home Assistant" \
  io.hass.type="app" \
  io.hass.arch="${BUILD_ARCH}" \
  io.hass.version="${BUILD_VERSION}"

ENV NODE_ENV=production \
    DSH_HOME=/data/dsh-home \
    DSH_TELEMETRY_DISABLED=1 \
    DSH_PERMISSION_MODE=workspace-write \
    DSH_BUNDLED_SKILL_DIR=/opt/ha-dsh/skills \
    DSH_WEB_PORT=3080 \
    DSH_INGRESS_PORT=8099 \
    DSH_ADDON_VERSION=${BUILD_VERSION}

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

