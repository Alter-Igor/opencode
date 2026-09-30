# egress proxy for the opencode-delegate box (FEAT-OCD-001 §1, review N3).
# tinyproxy from Alpine's main repository; the allowlist is generated (src/guard/egress.ts).
# The supervisor may mount a regenerated allow.txt over /etc/tinyproxy/allow.txt (read-only).
# Alpine 3.22 (supported to 2027-05; 3.20 used by the spike is past end of support). Pinned by digest.
FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8
RUN apk add --no-cache tinyproxy \
 && tinyproxy -v
COPY tinyproxy.conf /etc/tinyproxy/tinyproxy.conf
COPY allow.txt /etc/tinyproxy/allow.txt
USER nobody
EXPOSE 8888
CMD ["tinyproxy", "-d", "-c", "/etc/tinyproxy/tinyproxy.conf"]
