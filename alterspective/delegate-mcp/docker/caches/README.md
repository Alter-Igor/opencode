# Registry caches and egress — service contract

This folder and `docker/front/` hold the three network services that sit next to the box. The compose file (`docker/compose.yaml`) and the box image belong to the supervisor (MOD-01). This page is the contract they build against.

Why the caches exist: review finding N3. If the box could reach the public registries, an agent could publish a package and use that to get data out. So the box never reaches a registry. It reads packages through two read-only caches, and publishing through them does not work (live proof below).

## Services

| Service name | Port | Build dir | Base image (pinned by version + digest) | Networks | Volume |
|---|---|---|---|---|---|
| `front` | 443 | `docker/front` | `nginxinc/nginx-unprivileged:1.28.2-alpine` + `openssl` | `sealed` (aliases: the allowed hosts), `outside` | `front-ca-private` at `/ca/private` (CA key, front only); `front-ca-public` at `/ca/public` (CA certificate, read-only in the box); tmpfs `/tmp:uid=101,gid=101` |
| `npm-cache` | 4873 | `docker/caches/npm` | `verdaccio/verdaccio:6.10.4` | `sealed`, `outside` | named volume `npm-storage` at `/verdaccio/storage`; runs `read_only: true` with tmpfs `/tmp` |
| `pypi-cache` | 5000 | `docker/caches/pypi` | `nginxinc/nginx-unprivileged:1.28.2-alpine` | `sealed`, `outside` | named volume `pypi-storage` at `/var/cache/nginx/pypi`; runs `read_only: true` with tmpfs `/tmp:uid=101,gid=101` |

- `sealed` is `internal: true` (no route out). The box joins **only** `sealed`.
- None of the three publishes a host port.
- All three run as non-root: uid 101 (front and pypi-cache, nginx), uid 10001 (verdaccio).
- `docker/compose.yaml` also gives all three (and the box and both gates) `cap_drop: [ALL]`, `no-new-privileges`, a read-only root, and pids/memory/CPU limits. front binds :443 through the per-container sysctl `net.ipv4.ip_unprivileged_port_start=0`, not a capability.
- front's servers (`docker/front/servers.conf`) and certificate host list (`docker/front/hosts.txt`) are generated from `config.egressHosts` by `bun src/guard/egress.ts`. The tests fail if the committed files, or front's `sealed` aliases in compose.yaml, drift from the config. `oc_doctor` runs the same check (`egress` field).

## front: how the box gets out (review R3-01)

The old `egress` service was a tinyproxy CONNECT allowlist. It checked only the tunnel target. After CONNECT the box owned the TLS session, so it could send any SNI or `Host` to the shared front door behind an allowed host (Cloudflare for Keystone, Azure Container Apps for Synapse) and reach any other site there. It is removed. Nothing still needs its image.

`front` is a TLS-terminating reverse proxy with **one fixed upstream per allowed host**:

- The allowed names resolve, inside the box, to front's `sealed` address (network aliases). Nothing else resolves.
- front ends the box's TLS with a leaf certificate from its own internal CA. An SNI that names no allowed host fails the handshake (`ssl_reject_handshake`). A `Host` that differs from the SNI's server gets `421` and is never sent upstream.
- front opens its own verified TLS session to the real host, with SNI and `Host` forced to that host's name (`proxy_ssl_name`, `proxy_ssl_verify on`, system CA bundle). The box never picks the upstream.
- HTTP/1.1, no buffering, one-hour read timeout: MCP (streamable HTTP / SSE) and model streams pass through.
- No URIs or headers are logged.

**Name resolution (choice): aliases plus an explicit nginx resolver.** front would resolve its own aliases through Docker's DNS and point at itself (seen live on 2026-10-01). So nginx resolves upstreams with its own resolver: `OCD_FRONT_RESOLVER`, default `1.1.1.1 1.0.0.1`, IPv4 only. Set it on the host before the bridge starts if public DNS is blocked on your network; the bridge passes it to compose. A spoofed DNS answer cannot redirect traffic, because front checks the upstream certificate for the fixed name. A static IP plus `extra_hosts` was not chosen: it needs a fixed `sealed` subnet, which clashes between two projects (the default box and a throwaway test) and with other Docker networks.

**The internal CA.** front makes it on first start, inside the container, in the front-only volume `front-ca-private`. The private key never leaves front. Its name constraints permit only the allowed hosts (and exclude every IP), so even a stolen key could not make a certificate the box trusts for any other name. It is remade when missing, within 30 days of expiry (825-day life), or when the host list changes. A fresh leaf is made on every start, on tmpfs. Only the CA certificate is copied to `front-ca-public`, mounted read-only in the box at `/etc/ocd-front-ca/ca.pem`. The box waits for front to be healthy, because Bun reads its CA list once, at start.

**Bun honours `NODE_EXTRA_CA_CERTS` (verified live, 2026-10-01).** Bun 1.3.14 (the version OpenCode is compiled with) fetched the Keystone discovery document through front with `NODE_EXTRA_CA_CERTS` set (200) and failed without it (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`). curl, git and Python get the same file through `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO` and `REQUESTS_CA_BUNDLE` (not tested one by one: there is nothing else they could reach).

## Environment the box needs

```text
NODE_EXTRA_CA_CERTS=/etc/ocd-front-ca/ca.pem
SSL_CERT_FILE=/etc/ocd-front-ca/ca.pem
CURL_CA_BUNDLE=/etc/ocd-front-ca/ca.pem
GIT_SSL_CAINFO=/etc/ocd-front-ca/ca.pem
REQUESTS_CA_BUNDLE=/etc/ocd-front-ca/ca.pem
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

No proxy variables and no `NO_PROXY`: the caches and the inbox are plain service names on `sealed`, and the allowed hosts resolve to front. The bridge refuses a box env list that names any of these, or any `*_PROXY` (compose-env.ts). npm, pip and bun were tested live through the caches (bun on 2026-10-01: `bun add is-number` resolved through `npm-cache`). The `UV_` lines were not tested: uv is not installed in the box image.

## How the caches reach the internet — decision

**Choice:** the caches reach the registries **directly** through the `outside` network. They do **not** go through `front`.

**Why:** if a registry host were an allowed front host so the caches could use it, the box could use it too. That brings back the direct publish route that N3 closed. `src/guard/egress.ts` refuses to generate front config that contains a registry host, for this reason.

**What is left (residual risk):**
- The box can still send data **inside a package name** in a read request (for example `npm view <data>`), and the cache passes that name on to the public registry. It is a slow, one-way channel, and it goes to a registry's logs, not to a server an attacker controls. Accepted for Wave 1.
- A cache container that was compromised would have open internet access. They are single-purpose, run as non-root and hold no secrets. Accepted.

## ARCH-ASSESS-01 note (assessed 2026-10-01)

Short record under ARCH-ASSESS-01..04. **Not yet listed in `REF-REG-008`** (ARCH-ASSESS-05). That is a Knowledge Base change and outside this work item.

| Component | Version assessed | Maintainer | Why chosen | Tagged evidence |
|---|---|---|---|---|
| Verdaccio (npm cache) | `verdaccio/verdaccio:6.10.4` @ `sha256:43c40672…` | Verdaccio org (official image) | The usual self-hosted npm proxy. Rewrites tarball URLs to itself. Access rules can turn off every write action. | VERIFIED FACT: MIT, ~17.9k stars, last push 2026-09-29, not archived (`gh api repos/verdaccio/verdaccio`, 2026-10-01). VERIFIED FACT: publish refused (401), sign-up refused (409), web UI 404 (live check below). |
| nginx (PyPI cache) | `nginxinc/nginx-unprivileged:1.28.2-alpine` @ `sha256:7377697a…` | NGINX (F5), repo `nginx/docker-nginx-unprivileged` | A maintained image from the vendor, runs as non-root, and our config is about 50 lines. It is simpler than devpi or proxpi, which have no image of this standing. It serves GET/HEAD only and never proxies `upload.pypi.org`, so publishing cannot happen through it. | VERIFIED FACT: Apache-2.0, last push 2026-09-22 (`gh api`). VERIFIED FACT: `pip index versions` and `pip download` work, and POST is refused (403) (live check). INFERENCE: PEP 691 JSON clients get HTML (we ask upstream for `text/html` so the file links can be rewritten). pip and uv accept HTML. |
| nginx (front) | `nginxinc/nginx-unprivileged:1.28.2-alpine` @ `sha256:7377697a…` (+ Alpine `openssl`) | NGINX (F5), repo `nginx/docker-nginx-unprivileged` | The same assessed image as pypi-cache. nginx has `ssl_reject_handshake`, verified upstream TLS with a forced SNI (`proxy_ssl_name`) and streaming without buffering, which is all R3-01 needs. Replaces tinyproxy (removed: a CONNECT proxy cannot bind SNI/Host after the tunnel). | VERIFIED FACT: digest re-resolved 2026-10-01 (`docker buildx imagetools inspect`). VERIFIED FACT: red/green live check below. JUDGEMENT: `openssl` from Alpine's repository is not version-pinned; it only makes the CA and the leaf. |

Re-assessment trigger: a major version bump of any of the three, a security advisory against one, or 2027-04-01, whichever comes first.

## Caches live check (2026-10-01; egress rows are from the removed tinyproxy proxy)

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

The plain-HTTP gap noted for tinyproxy is gone with it: front listens only on 443 with TLS.

## front live check (2026-10-01, review R3-01)

Run by `test/egress-live.test.ts` (`OCD_LIVE_EGRESS=1`): the real `front` service from `docker/compose.yaml`, plus two probes on `sealed` only (`docker/front/live/probe.yaml`), in a throwaway project that is removed afterwards with `down -v` and its image deleted. Only public, read-only GETs; no credentials.

| Check (from a container on `sealed`) | Result |
|---|---|
| (a) `GET https://identity.alterspective.com.au/.well-known/oauth-authorization-server`, front's CA | `200`, `issuer` = `https://identity.alterspective.com.au` |
| same, public roots only | `UNABLE_TO_VERIFY_LEAF_SIGNATURE` (front, not the real host, ended the TLS) |
| `GET https://synapse2-api.alterspective.com.au/v1/models` (no key) | `401` (reachable) |
| Bun 1.3.14 `fetch` of (a), with / without `NODE_EXTRA_CA_CERTS` | `200` / `UNABLE_TO_VERIFY_LEAF_SIGNATURE` |
| (b) SNI `www.cloudflare.com` to identity's name, `/cdn-cgi/trace` | handshake refused (`tlsv1 unrecognized name`) |
| (b) SNI `vault-mcp.alterspective.com.au` to synapse2-api's name | handshake refused (`tlsv1 unrecognized name`) |
| (c) synapse2-api SNI, `Host: vault-mcp.alterspective.com.au`, `/health` | `421 Misdirected Request` (nginx page; never vault-mcp's answer) |
| (c) synapse2-api SNI, `Host: identity.alterspective.com.au` | `421` |
| (c) absolute URI `GET https://vault-mcp…/health` with synapse2-api `Host` | `421` |
| (d) DNS for `www.cloudflare.com`, `vault-mcp…`, a random name, `egress` | no answer; the allowed names resolve to front only |
| (d) TLS to front's IP with no SNI | handshake refused (`unrecognized name`) |
| (d) TCP to `1.1.1.1:443` | `ENETUNREACH` |
| (e) `CONNECT` inside TLS to front / in plain TCP to front:443 | `400 Bad Request` / `400 Bad Request` |
| (e) front ports 8888, 3128, 8080, 80 | `ECONNREFUSED` |
