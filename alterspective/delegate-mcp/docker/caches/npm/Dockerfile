# npm-cache (FEAT-OCD-001 review N3): Verdaccio as a read-only pull-through cache.
# Image assessed in docker/caches/README.md (ARCH-ASSESS-01). Pinned by version and digest.
FROM verdaccio/verdaccio:6.10.4@sha256:43c4067288b050422265407ea2fe747e511fcd0c407a85ec90ab9a326d9400cd
USER root
COPY config.yaml /verdaccio/conf/config.yaml
# Empty, root-owned, read-only credential file: no account can ever be created or used.
RUN : > /verdaccio/conf/htpasswd \
 && chown -R root:root /verdaccio/conf \
 && chmod 0444 /verdaccio/conf/htpasswd /verdaccio/conf/config.yaml \
 && chmod 0555 /verdaccio/conf
USER verdaccio
EXPOSE 4873
