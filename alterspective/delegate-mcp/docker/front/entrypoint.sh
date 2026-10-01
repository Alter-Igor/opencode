#!/bin/sh
# front entrypoint (FEAT-OCD-001 §1, review R3-01). Runs as uid 101 (nginx), no capabilities.
# 1. The internal CA is made here, on first start, into /ca/private (a front-only volume), so its
#    private key never leaves this container. It is remade when it is missing, close to expiry,
#    or was made for a different host list. Its name constraints allow ONLY the allowed hosts, so
#    even a stolen CA key could not mint a certificate the box trusts for any other name.
# 2. Only the CA certificate (public) is copied to /ca/public, which the box mounts read-only.
# 3. A fresh leaf certificate for the allowed hosts is made on every start, on the /tmp tmpfs.
# 4. The nginx resolver line is written from OCD_FRONT_RESOLVER (IPv4 addresses only).
# 5. The generated servers.conf must have the hash the bridge started front with (OCD_FRONT_HASH,
#    also the front-config label, review R5-05). The bridge writes the file before `compose up`;
#    if `up` failed while an older front kept running, a later restart would otherwise load the
#    new file under the old label. A mismatch stops front, so the box has no way out at all.
set -eu
umask 077

HOSTS=/etc/nginx/front/hosts.txt
PRIV=/ca/private
PUB=/ca/public
RUN=/tmp/front
# Kept short so a stale CA is replaced well before it expires (checked on every start).
CA_DAYS=825
LEAF_DAYS=397
RENEW_SECONDS=2592000

log() { printf 'front: %s\n' "$*" >&2; }

names=$(grep -v '^#' "$HOSTS" | grep -v '^$')
[ -n "$names" ] || { log "no allowed hosts in $HOSTS"; exit 1; }
mkdir -p "$RUN"

resolver=${OCD_FRONT_RESOLVER:-1.1.1.1 1.0.0.1}
for ip in $resolver; do
  case "$ip" in
    *[!0-9.]* | .* | *. | *..*) log "OCD_FRONT_RESOLVER must be IPv4 addresses separated by spaces"; exit 1 ;;
  esac
done
[ -n "$(echo $resolver)" ] || { log "OCD_FRONT_RESOLVER is empty"; exit 1; }
printf 'resolver %s valid=300s ipv6=off;\nresolver_timeout 10s;\n' "$(echo $resolver)" > "$RUN/resolver.conf"

constraints=""
sans=""
for name in $names; do
  constraints="${constraints}permitted;DNS:${name},"
  sans="${sans}DNS:${name},"
done
constraints="${constraints}excluded;IP:0.0.0.0/0.0.0.0,excluded;IP:::/::"
sans=${sans%,}
first=$(echo "$names" | head -n 1)

ca_ok() {
  [ -s "$PRIV/ca.key" ] && [ -s "$PRIV/ca.pem" ] && cmp -s "$HOSTS" "$PRIV/hosts.txt" \
    && openssl x509 -checkend "$RENEW_SECONDS" -noout -in "$PRIV/ca.pem" > /dev/null 2>&1
}

if ! ca_ok; then
  log "making a new internal CA for: $(echo $names)"
  openssl req -x509 -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
    -keyout "$PRIV/ca.key.new" -out "$PRIV/ca.pem.new" -days "$CA_DAYS" -sha256 \
    -subj "/CN=opencode-delegate front CA" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -addext "nameConstraints=critical,${constraints}" 2> "$RUN/openssl.err" \
    || { cat "$RUN/openssl.err" >&2; exit 1; }
  mv -f "$PRIV/ca.key.new" "$PRIV/ca.key"
  mv -f "$PRIV/ca.pem.new" "$PRIV/ca.pem"
  cp "$HOSTS" "$PRIV/hosts.txt"
fi

# Public half only; written then renamed, so the box never reads a half-written file.
cp "$PRIV/ca.pem" "$PUB/ca.pem.new"
chmod 0644 "$PUB/ca.pem.new"
mv -f "$PUB/ca.pem.new" "$PUB/ca.pem"

cat > "$RUN/leaf.ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
subjectAltName=${sans}
EOF
openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -keyout "$RUN/leaf.key" -out "$RUN/leaf.csr" -subj "/CN=${first}" 2> "$RUN/openssl.err" \
  || { cat "$RUN/openssl.err" >&2; exit 1; }
openssl x509 -req -in "$RUN/leaf.csr" -CA "$PRIV/ca.pem" -CAkey "$PRIV/ca.key" \
  -set_serial "0x$(openssl rand -hex 16)" -days "$LEAF_DAYS" -sha256 \
  -extfile "$RUN/leaf.ext" -out "$RUN/leaf.pem" 2> "$RUN/openssl.err" \
  || { cat "$RUN/openssl.err" >&2; exit 1; }
rm -f "$RUN/leaf.csr" "$RUN/openssl.err"

actual=$(sha256sum /etc/nginx/front-gen/servers.conf | cut -d' ' -f1)
[ "$actual" = "$OCD_FRONT_HASH" ] || { log "servers.conf does not match OCD_FRONT_HASH; refusing to start (restart the sandbox through the bridge)"; exit 1; }
# 6. Review Low 4: the same checks the bridge's reloads go through (front-reload), including the
#    strict shape of the Synapse include, before nginx ever reads it.
/usr/local/bin/front-reload --check || { log "the generated files failed front-reload --check; refusing to start"; exit 1; }

log "ready: $(echo $names) (CA $(openssl x509 -noout -fingerprint -sha256 -in "$PUB/ca.pem" | cut -d= -f2))"
exec nginx -g 'daemon off;'
