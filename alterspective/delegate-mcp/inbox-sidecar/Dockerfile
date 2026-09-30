# FEAT-OCD-001 MOD-05: the inbox sidecar (technical-design.md §7, review G5).
# A tiny Bun HTTP service with its own named volume at /data. Two listeners (W2C-05):
#   8080  box routes, on `sealed`, no token (box messages are stored unverified)
#   8081  admin routes, bound to the `admin` network address only (compose sets
#         INBOX_ADMIN_HOST); the gate publishes it on host 127.0.0.1. Needs the per-start admin
#         token (INBOX_ADMIN_TOKEN, container env only).
# No dependencies to install. Same Bun image and digest as the box build stage (docker/box/Dockerfile, review C-9).
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
WORKDIR /app
COPY --chown=root:root src/ /app/src/
# /data belongs to the unprivileged `bun` user so a new named volume starts out writable by it.
RUN mkdir -p /data && chown bun:bun /data && chmod 0700 /data
LABEL org.opencontainers.image.title="opencode-delegate-inbox" \
      com.alterspective.feature="FEAT-OCD-001"
USER bun
# The root filesystem is read-only: no transpiler cache on disk.
ENV INBOX_PORT=8080 INBOX_ADMIN_PORT=8081 INBOX_DATA_DIR=/data BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
EXPOSE 8080 8081
# Probes the box-side read route (there is no separate health route by design). The Host header
# is the one box clients send, since the listener refuses any other (W2C-13).
HEALTHCHECK --interval=10s --timeout=5s --retries=3 --start-period=5s \
  CMD ["bun", "-e", "const r = await fetch('http://127.0.0.1:8080/v1/read?to=session:ses_healthcheck', { headers: { host: 'inbox:8080' } }); process.exit(r.status === 200 ? 0 : 1)"]
CMD ["bun", "run", "/app/src/main.ts"]
