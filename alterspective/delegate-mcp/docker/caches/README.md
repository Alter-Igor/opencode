# Registry caches and egress — service contract

This folder and `docker/egress/` hold the three network services that sit next to the box. The compose file (`docker/compose.yaml`) and the box image belong to the supervisor (MOD-01). This page is the contract they build against.

Why the caches exist: review finding N3. If the box could reach the public registries, an agent could publish a package and use that to get data out. So the box never reaches a registry. It reads packages through two read-only caches, and publishing through them does not work (live proof below).

## Services

| Service name | Port | Build dir | Base image (pinned by version + digest) | Networks | Volume |
|---|---|---|---|---|---|
| `egress` | 8888 | `docker/egress` | `alpine:3.22` + tinyproxy 1.11.2 | `sealed`, `outside` | none (runs `read_only: true`) |
| `npm-cache` | 4873 | `docker/caches/npm` | `verdaccio/verdaccio:6.10.4` | `sealed`, `outside` | named volume `npm-storage` at `/verdaccio/storage`; runs `read_only: true` with tmpfs `/tmp` |
| `pypi-cache` | 5000 | `docker/caches/pypi` | `nginxinc/nginx-unprivileged:1.28.2-alpine` | `sealed`, `outside` | named volume `pypi-storage` at `/var/cache/nginx/pypi`; runs `read_only: true` with tmpfs `/tmp:uid=101,gid=101` |

- `sealed` is `internal: true` (no route out). The box joins **only** `sealed`.
- None of the three publishes a host port.
- All three run as non-root: `nobody` (egress), uid 10001 (verdaccio), uid 101 (nginx).
- `docker/compose.yaml` also gives all three (and the box and gate) `cap_drop: [ALL]`, `no-new-privileges`, and pids/memory/CPU limits.
- The egress allowlist is `docker/egress/allow.txt`, generated from `config.egressHosts` by `bun src/guard/egress.ts` (the tests fail if the committed file drifts). If the supervisor runs with a non-default host list, it writes `egressAllowlist(config.egressHosts)` to a file and mounts it read-only over `/etc/tinyproxy/allow.txt`.

## Environment the box needs

```text
HTTPS_PROXY=http://egress:8888
HTTP_PROXY=http://egress:8888
https_proxy=http://egress:8888
http_proxy=http://egress:8888
NO_PROXY=npm-cache,pypi-cache,localhost,127.0.0.1
no_proxy=npm-cache,pypi-cache,localhost,127.0.0.1
npm_config_registry=http://npm-cache:4873/
BUN_CONFIG_REGISTRY=http://npm-cache:4873/
npm_config_audit=false
npm_config_fund=false
npm_config_update_notifier=false
PIP_INDEX_URL=http://pypi-cache:5000/index/
PIP_TRUSTED_HOST=pypi-cache
PIP_DISABLE_PIP_VERSION_CHECK=1
UV_DEFAULT_INDEX=http://pypi-cache:5000/index/
UV_INSECURE_HOST=pypi-cache
```

`NO_PROXY` is required. Without it, npm and pip send cache requests to `egress`, which refuses them (the cache names are not on the allowlist). The box sets every line above (`docker/compose.yaml`). npm, pip and bun were tested live (bun on 2026-10-01: `bun add is-number` resolved through `npm-cache`). The `UV_` lines were not tested: uv is not installed in the box image.

## How the caches reach the internet — decision

**Choice:** the caches reach the registries **directly** through the `outside` network. They do **not** go through `egress`.

**Why:** tinyproxy filters by destination host. It cannot tell which container is asking. So if `registry.npmjs.org`, `pypi.org` or `files.pythonhosted.org` were on the allowlist so the caches could use them, the box could use them too. That brings back the direct publish route that N3 closed. `src/guard/egress.ts` refuses to generate an allowlist that contains a registry host, for this reason.

**What is left (residual risk):**
- The box can still send data **inside a package name** in a read request (for example `npm view <data>`), and the cache passes that name on to the public registry. It is a slow, one-way channel, and it goes to a registry's logs, not to a server an attacker controls. Accepted for Wave 1.
- A cache container that was compromised would have open internet access. They are single-purpose, run as non-root and hold no secrets. Accepted.

## ARCH-ASSESS-01 note (assessed 2026-10-01)

Short record under ARCH-ASSESS-01..04. **Not yet listed in `REF-REG-008`** (ARCH-ASSESS-05). That is a Knowledge Base change and outside this work item.

| Component | Version assessed | Maintainer | Why chosen | Tagged evidence |
|---|---|---|---|---|
| Verdaccio (npm cache) | `verdaccio/verdaccio:6.10.4` @ `sha256:43c40672…` | Verdaccio org (official image) | The usual self-hosted npm proxy. Rewrites tarball URLs to itself. Access rules can turn off every write action. | VERIFIED FACT: MIT, ~17.9k stars, last push 2026-09-29, not archived (`gh api repos/verdaccio/verdaccio`, 2026-10-01). VERIFIED FACT: publish refused (401), sign-up refused (409), web UI 404 (live check below). |
| nginx (PyPI cache) | `nginxinc/nginx-unprivileged:1.28.2-alpine` @ `sha256:7377697a…` | NGINX (F5), repo `nginx/docker-nginx-unprivileged` | A maintained image from the vendor, runs as non-root, and our config is about 50 lines. It is simpler than devpi or proxpi, which have no image of this standing. It serves GET/HEAD only and never proxies `upload.pypi.org`, so publishing cannot happen through it. | VERIFIED FACT: Apache-2.0, last push 2026-09-22 (`gh api`). VERIFIED FACT: `pip index versions` and `pip download` work, and POST is refused (403) (live check). INFERENCE: PEP 691 JSON clients get HTML (we ask upstream for `text/html` so the file links can be rewritten). pip and uv accept HTML. |
| tinyproxy (egress) | 1.11.2 from Alpine 3.22 @ `sha256:5291449c…` | tinyproxy project; Alpine packages | Already proven in spike T0.1. Small. Has CONNECT port limits and default-deny host filters. | VERIFIED FACT: GPL-2.0, last push 2026-09-21 (`gh api`). JUDGEMENT: the spike used Alpine 3.20. We moved to 3.22 because 3.20 is past end of support. |

Re-assessment trigger: a major version bump of any of the three, a security advisory against one, or 2027-04-01, whichever comes first.

## Live check (2026-10-01)

Setup: a throwaway compose project `ocd-guardtest` with these three images, plus a client container (`node:22-alpine` with pip and curl) on `sealed` only, using the box environment above. It was torn down afterwards with `docker compose -p ocd-guardtest down -v`. `ocd-spike` was not touched.

| Check (run from the sealed client) | Result |
|---|---|
| `npm view left-pad version` | `1.3.0` |
| `npm install left-pad` | installed; lockfile `resolved` is `http://npm-cache:4873/…` |
| `npm publish` (no token) | `ENEEDAUTH` |
| `npm publish` with a forged token | server `E401` (`authorization required to publish package`) |
| `PUT /-/user/org.couchdb.user:…` (sign-up) | `409 user registration disabled` |
| `pip index versions six` | `six (1.17.0)` |
| `pip download six` / `pip install --user six` | downloaded / installed through the cache |
| `POST http://pypi-cache:5000/index/` (upload) | `403` |
| `curl https://registry.npmjs.org/` | refused by egress (`CONNECT tunnel failed, response 403`) |
| `curl https://upload.pypi.org/legacy/` | refused by egress (403) |
| `curl https://rag.alterspective.com.au/mcp` | refused by egress (403); with `--noproxy "*"`: no DNS (exit 6) |
| `curl https://identity.alterspective.com.au.evil.com/` | refused by egress (403) |
| `curl https://identity.alterspective.com.au:8443/` | refused (`Refused CONNECT method on port 8443`) |
| `curl https://identity.alterspective.com.au/.well-known/openid-configuration` | `200` (allowed) |
| `curl https://synapse2-api.alterspective.com.au/v1/models` (no key) | `401` (reachable) |

A defect was found and fixed during the check. nginx does not pass `proxy_set_header` from the server block down to a location that sets its own headers. So pip's `Accept-Encoding: gzip` reached PyPI, the index came back compressed, the link rewrite was skipped, and pip then tried `files.pythonhosted.org` directly. egress refused that, so the system still failed closed. Each location now sets the full header set itself.

Known gap: egress still allows plain-HTTP requests (not CONNECT) to allowlisted hosts on other ports. tinyproxy's `ConnectPort` only limits CONNECT. This was not tested. It only reaches hosts that are already allowed.
