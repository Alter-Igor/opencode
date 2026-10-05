# Sandbox worker image for CAS delegation (FEAT-CAS-012 Phase 1, fork issue #47).
# Build from the repository root:
#   docker build -f alterspective/sandbox-worker/Dockerfile --build-arg GIT_SHA=$(git rev-parse HEAD) \
#     -t opencodealt-sandbox-worker:spike .
# The build context is filtered by Dockerfile.dockerignore beside this file, not the root .dockerignore.

FROM oven/bun:1.3.14 AS build
# No .git in the build context, so the build script cannot read the branch for its channel name.
ENV OPENCODE_CHANNEL=sandbox-worker
# Native install scripts (tree-sitter-powershell via node-gyp) need python and a C toolchain.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile
# --single builds the native linux-x64 (glibc) binary only; the web UI is not needed headless.
RUN cd packages/opencode && bun run script/build.ts --single --skip-embed-web-ui

FROM oven/bun:1.3.14-slim
ARG GH_VERSION=2.62.0
# #108: the fork commit this image is built from. The build context has no .git, so pass it in:
#   docker build --build-arg GIT_SHA=$(git rev-parse HEAD) ...
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.revision=$GIT_SHA \
      org.opencontainers.image.source=https://github.com/Alter-Igor/opencode
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ripgrep ca-certificates curl nftables \
  && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
    | tar -xz -C /tmp \
  && mv "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh \
  && rm -rf /tmp/gh_* /var/lib/apt/lists/*

# Real Node.js and npm. The bun base image ships a `node` shim that cannot run `node --test`;
# in the first real run the agent spent 39 shell calls working out why (fork issue #47).
# Copying the node image's /usr/local replaces that shim and leaves bun in place.
COPY --from=node:22-bookworm-slim /usr/local /usr/local
COPY --from=build /src/packages/opencode/dist/opencode-linux-x64/bin/opencode /usr/local/bin/opencode
COPY alterspective/sandbox-worker/supervisor /opt/sbxw/supervisor
COPY alterspective/sandbox-worker/plugins /opt/sbxw/plugins
# #118: the in-sandbox egress lockdown. ROOT runs it before the supervisor (the E2B start command):
#   SBXW_EGRESS_ALLOW=<gateway ip:port> bun /opt/sbxw/egress/lockdown.ts
# A non-zero exit means: do not start the supervisor.
COPY alterspective/sandbox-worker/egress/lockdown.ts alterspective/sandbox-worker/egress/rules.ts /opt/sbxw/egress/

# Non-root user. Data and work dirs are pre-created and owned by it (a root-owned volume
# made OpenCode exit with EACCES in the #41 spike).
RUN useradd -m -u 10001 agent \
  && mkdir -p /data /work /run/sbxw \
  && chown agent:agent /data /work /run/sbxw \
  && opencode --version && node --version && npm --version && bun --version

USER agent
ENV SBXW_BUILD_SHA=$GIT_SHA \
    XDG_DATA_HOME=/data \
    XDG_CONFIG_HOME=/run/sbxw/xdg-config \
    XDG_STATE_HOME=/data/state \
    XDG_CACHE_HOME=/data/cache \
    OPENCODE_CONFIG_DIR=/run/sbxw/config \
    OPENCODE_DISABLE_PROJECT_CONFIG=1 \
    OPENCODE_DISABLE_MODELS_FETCH=1 \
    OPENCODE_DISABLE_AUTOUPDATE=1 \
    OPENCODE_DISABLE_SESSION_RETROSPECTIVES=1 \
    BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
WORKDIR /work
EXPOSE 4096
ENTRYPOINT ["bun", "/opt/sbxw/supervisor/main.ts"]
