# syntax=docker/dockerfile:1.7
# FEAT-OCD-001 T1.2: the delegate box. Builds OUR fork of OpenCode (with the
# OPENCODE_MCP_ALLOW patch, packages/opencode/src/mcp/allowlist.ts) from this checkout.
# Build context = repo root (see docker/compose.yaml); ignore rules: Dockerfile.dockerignore.

# ---- stage 1: compile a linux-x64 single binary from the fork source ----
# Bun version must match root package.json "packageManager" (packages/script checks ^version).
# Base images are pinned by version and digest (review C-9); resolved 2026-10-01 with
# `docker buildx imagetools inspect <image>:<tag>` (multi-arch index digests).
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS build
WORKDIR /src
COPY . .
# --ignore-scripts: skips husky (needs .git) and electron downloads; the compiled
# binary does not need them. fix-node-pty only chmods a macOS helper.
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --ignore-scripts
# Script (packages/script) reads the channel from git unless OPENCODE_CHANNEL is set,
# so no .git is needed in the context. The version is stamped by the bridge.
ARG OPENCODE_VERSION=0.0.0-alterspective-local
ENV OPENCODE_CHANNEL=alterspective \
    OPENCODE_VERSION=${OPENCODE_VERSION}
# build.ts runs a --version smoke test of the produced binary before it returns.
RUN bun run --cwd packages/opencode script/build.ts --single --skip-embed-web-ui --skip-install \
    && test -x packages/opencode/dist/opencode-linux-x64/bin/opencode

# ---- stage 2: the runtime box ----
FROM node:22-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
RUN apt-get update \
    && apt-get install -y --no-install-recommends git curl ca-certificates python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*
# Root-owned, not writable by the agent user (review N1).
COPY --from=build --chown=root:root --chmod=0755 /src/packages/opencode/dist/opencode-linux-x64/bin/opencode /usr/local/bin/opencode
COPY --from=build --chown=root:root --chmod=0755 /usr/local/bin/bun /usr/local/bin/bun
RUN useradd -m -u 10001 -s /bin/bash agent \
    && mkdir -p /data /sessions /handoff/in /handoff/out /profile \
    && chown agent:agent /data /sessions /handoff/out \
    && git config --system safe.directory '*' \
    && git config --system init.defaultBranch main \
    && git config --system user.name "OpenCode Delegate (Synapse)" \
    && git config --system user.email "opencode-delegate@users.noreply.github.com" \
    && opencode --version
ARG OPENCODE_VERSION=0.0.0-alterspective-local
LABEL org.opencontainers.image.title="opencode-delegate-box" \
      org.opencontainers.image.version="${OPENCODE_VERSION}" \
      com.alterspective.feature="FEAT-OCD-001"
USER agent
WORKDIR /sessions
EXPOSE 4096
CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
