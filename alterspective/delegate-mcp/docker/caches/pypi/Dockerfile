# pypi-cache (FEAT-OCD-001 review N3): nginx caching reverse proxy of the PyPI simple index.
# Image assessed in docker/caches/README.md (ARCH-ASSESS-01). Pinned by version and digest.
FROM nginxinc/nginx-unprivileged:1.28.2-alpine@sha256:7377697a821c131a924a7105fafbe7414db4e9fcc77a6f08f776f33f141ec3f8
USER root
RUN rm -f /etc/nginx/conf.d/default.conf \
 && mkdir -p /var/cache/nginx/pypi \
 && chown -R nginx:nginx /var/cache/nginx
COPY nginx.conf /etc/nginx/conf.d/pypi.conf
USER nginx
EXPOSE 5000
