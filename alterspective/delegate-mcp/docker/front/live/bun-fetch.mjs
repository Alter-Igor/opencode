// Runs INSIDE probe-bun (docker/front/live/probe.yaml). Prints one JSON object.
// A public, read-only discovery GET through front. No credentials are ever sent.
const url = "https://identity.alterspective.com.au/.well-known/oauth-authorization-server"
try {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
  const body = await res.json().catch(() => ({}))
  console.log(JSON.stringify({ ok: true, status: res.status, issuer: body.issuer ?? null, extraCa: process.env.NODE_EXTRA_CA_CERTS ?? null, bun: Bun.version }))
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error?.code ?? error?.message ?? error), extraCa: process.env.NODE_EXTRA_CA_CERTS ?? null, bun: Bun.version }))
}
