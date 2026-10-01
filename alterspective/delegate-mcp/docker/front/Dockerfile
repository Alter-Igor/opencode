# front: the sealed box's only way out (FEAT-OCD-001 technical-design §1, review R3-01).
# A TLS-terminating reverse proxy with one fixed upstream per allowed host. It replaces the
# tinyproxy CONNECT allowlist, which let the box choose SNI and Host after CONNECT.
# hosts.txt is generated from config.egressHosts (bun src/guard/egress.ts). servers.conf is NOT in
# the image: it depends on the Keystone connections chosen at runtime (review R4-01), so the bridge
# writes it into its home and compose mounts that folder read-only at /etc/nginx/front-gen.
# Same base image as docker/caches/pypi (assessed in docker/caches/README.md, ARCH-ASSESS-01).
# Pinned by version and digest; resolved 2026-10-01 with
# `docker buildx imagetools inspect nginxinc/nginx-unprivileged:1.28.2-alpine`.
FROM nginxinc/nginx-unprivileged:1.28.2-alpine@sha256:7377697a821c131a924a7105fafbe7414db4e9fcc77a6f08f776f33f141ec3f8
USER root
# openssl makes the internal CA and the leaf certificate at start (entrypoint.sh).
# /ca/private holds the CA key (front-only volume); /ca/public holds the CA certificate the box
# trusts (mounted read-only in the box). The volumes copy this ownership on first use.
RUN apk add --no-cache openssl \
 && rm -f /etc/nginx/conf.d/default.conf \
 && mkdir -p /etc/nginx/front /etc/nginx/front-gen /ca/private /ca/public \
 && chown nginx:nginx /ca/private /ca/public \
 && chmod 0700 /ca/private \
 && chmod 0755 /ca/public
COPY nginx.conf /etc/nginx/nginx.conf
COPY upstream.conf hosts.txt /etc/nginx/front/
COPY --chmod=0755 entrypoint.sh /usr/local/bin/front-entrypoint
# Review M1: the bridge reloads front only through this script (checks the files first).
COPY --chmod=0755 front-reload.sh /usr/local/bin/front-reload
# Belt and braces with .gitattributes: a Windows checkout may still hand us CRLF files.
RUN sed -i 's/\r$//' /usr/local/bin/front-entrypoint /usr/local/bin/front-reload /etc/nginx/nginx.conf /etc/nginx/front/*
USER nginx
EXPOSE 443
ENTRYPOINT ["/usr/local/bin/front-entrypoint"]
