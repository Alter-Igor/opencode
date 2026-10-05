# #104: the delegation gate for Keystone /mcp/dynamic (src/server.ts).
# A tiny Bun HTTP service, no dependencies to install. Two listeners:
#   8090  front listener, on the internal `gatenet` network only (front reaches it; the box does not)
#   8091  admin listener, bound to the `admin` network address only (compose sets GATE_ADMIN_HOST);
#         a socat gate publishes it on host 127.0.0.1. Needs the per-start GATE_ADMIN_TOKEN.
# Same Bun image and digest as the inbox sidecar and the box build stage (review C-9).
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
WORKDIR /app
COPY --chown=root:root src/ /app/src/
LABEL org.opencontainers.image.title="opencode-delegate-mcp-gate" \
      com.alterspective.feature="FEAT-OCD-001"
USER bun
# The root filesystem is read-only: no transpiler cache on disk.
ENV GATE_PORT=8090 GATE_ADMIN_PORT=8091 BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
EXPOSE 8090 8091
# Probes the front listener on its own address (GATE_HOST): any path but /mcp/dynamic answers 403.
HEALTHCHECK --interval=10s --timeout=5s --retries=3 --start-period=5s \
  CMD ["bun", "-e", "const r = await fetch('http://' + (process.env.GATE_HOST || '127.0.0.1') + ':8090/health-probe'); process.exit(r.status === 403 ? 0 : 1)"]
CMD ["bun", "run", "/app/src/main.ts"]
