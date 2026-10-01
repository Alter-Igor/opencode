// R4-01 — front's Keystone server allows only the chosen connections' paths (egress-identity.ts).
// Two layers of proof:
// 1. The generated config itself: exact locations only, a 403 default, each location forwards ONLY
//    its own literal path (never $uri / $request_uri, never the raw request), methods limited,
//    query strings refused.
// 2. Request routing under nginx's documented URI handling (percent-decoding, `.`/`..` removal,
//    `//` merging, case-sensitive exact match), emulated by `route` below over the parsed config.
//    The live test (egress-live.test.ts, OCD_LIVE_EGRESS=1) sends the same tricks to the real front.
import { describe, expect, test } from "bun:test"
import { identityPaths, KEYSTONE_OAUTH_PATHS } from "../src/guard/egress-identity.ts"
import { frontServers } from "../src/guard/egress.ts"

const HOSTS = ["identity.alterspective.com.au", "synapse2-api.alterspective.com.au"]
const IDENTITY = "identity.alterspective.com.au"
const CHOSEN = ["rag-read", "github", "seqlogs"]
const conf = frontServers(HOSTS, { host: IDENTITY, connections: CHOSEN })

/** The body of the `server { ... }` block named `host`. */
function serverBody(text: string, host: string): string {
  const blocks = [...text.matchAll(/^server \{\n([\s\S]*?)\n\}$/gm)].map((m) => m[1] ?? "")
  const found = blocks.find((b) => b.includes(`    server_name ${host};`))
  if (!found) throw new Error(`no server for ${host}`)
  return found
}

type Location = { match: string; exact: boolean; body: string }

function locations(body: string): Location[] {
  return [...body.matchAll(/^ {4}location (= )?(\S+) \{\n([\s\S]*?)\n {4}\}$/gm)].map((m) => ({ exact: m[1] === "= ", match: m[2] ?? "", body: m[3] ?? "" }))
}

const identity = serverBody(conf, IDENTITY)
const locs = locations(identity)

/** nginx's URI normalisation (ngx_http_parse_complex_uri): decode %XX, merge `//`, remove `.`/`..`. 400 on a bad escape, NUL, or `..` above root. */
function normalise(rawPath: string): string | 400 {
  if (/%(?![0-9a-fA-F]{2})/.test(rawPath)) return 400
  // Byte-wise, like nginx (no UTF-8 check).
  const decoded = rawPath.replace(/%([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
  if (decoded.includes("\0")) return 400
  const out: string[] = []
  for (const segment of decoded.replace(/\/{2,}/g, "/").split("/").slice(1)) {
    if (segment === ".") continue
    if (segment === "..") {
      if (out.length === 0) return 400
      out.pop()
      continue
    }
    out.push(segment)
  }
  const trailing = decoded.endsWith("/") && !decoded.endsWith("/.") && !decoded.endsWith("/..") && out.length > 0 && out.at(-1) !== ""
  return "/" + out.join("/") + (trailing ? "/" : "")
}

type Routed = { status: number; upstream?: string }

/** Where front sends `method target` for the identity host, per the parsed config. */
function route(method: string, target: string): Routed {
  const q = target.indexOf("?")
  const rawPath = q === -1 ? target : target.slice(0, q)
  const args = q === -1 ? "" : target.slice(q + 1)
  const uri = normalise(rawPath)
  if (uri === 400) return { status: 400 }
  const loc = locs.find((l) => l.exact && l.match === uri) ?? locs.find((l) => !l.exact && l.match === "/")!
  if (/return 403;/.test(loc.body) && !loc.exact) return { status: 403 }
  const allowed = (/limit_except ([A-Z ]+) \{ deny all; \}/.exec(loc.body)?.[1] ?? "").split(" ")
  if (!allowed.includes(method) && !(method === "HEAD" && allowed.includes("GET"))) return { status: 403 }
  if (args.length > 0 && /if \(\$is_args\) \{ return 403; \}/.test(loc.body)) return { status: 403 }
  const upstream = /proxy_pass https:\/\/\$front_upstream(\S*);/.exec(loc.body)?.[1]
  return { status: 0, upstream }
}

describe("generated identity server (R4-01)", () => {
  test("refuses by default: `location /` returns 403 and proxies nothing", () => {
    const fallback = locs.filter((l) => !l.exact)
    expect(fallback.map((l) => l.match)).toEqual(["/"])
    expect(fallback[0]!.body.trim()).toBe("return 403;")
  })

  test("exactly the allowed paths, each an exact location forwarding only its own literal path", () => {
    const expected = identityPaths(CHOSEN)
    expect(locs.filter((l) => l.exact).map((l) => l.match)).toEqual(expected.map((p) => p.path))
    for (const loc of locs.filter((l) => l.exact)) {
      const passes = [...loc.body.matchAll(/proxy_pass (\S+);/g)].map((m) => m[1])
      expect(passes).toEqual([`https://$front_upstream${loc.match}`])
      expect(loc.body).toContain(`proxy_ssl_name ${IDENTITY};`)
      expect(loc.body).toContain(`proxy_set_header Host ${IDENTITY};`)
      expect(loc.body).toContain("if ($is_args) { return 403; }")
    }
  })

  test("the allowed set: OAuth discovery, registration, token, and per connection its resource metadata and MCP endpoint", () => {
    const methods = Object.fromEntries(identityPaths(CHOSEN).map((p) => [p.path, p.methods.join(" ")]))
    expect(methods).toEqual({
      "/.well-known/oauth-authorization-server": "GET",
      "/.well-known/openid-configuration": "GET",
      "/api/oauth/register": "POST",
      "/api/oidc/token": "POST",
      "/.well-known/oauth-protected-resource/mcp/c/rag-read": "GET",
      "/mcp/c/rag-read": "GET POST DELETE",
      "/.well-known/oauth-protected-resource/mcp/c/github": "GET",
      "/mcp/c/github": "GET POST DELETE",
      "/.well-known/oauth-protected-resource/mcp/c/seqlogs": "GET",
      "/mcp/c/seqlogs": "GET POST DELETE",
    })
    // The owner's browser opens /api/oauth/authorize; the box never needs it.
    expect(KEYSTONE_OAUTH_PATHS.map((p) => p.path)).not.toContain("/api/oauth/authorize")
    expect(identity).not.toContain("/mcp/dynamic {")
    expect(identity).not.toContain("location = /api/mcp")
  })

  test("the model gateway server is unchanged (whole host, raw URI)", () => {
    const synapse = locations(serverBody(conf, "synapse2-api.alterspective.com.au"))
    expect(synapse.map((l) => [l.exact, l.match])).toEqual([[false, "/"]])
    expect(synapse[0]!.body).toContain("proxy_pass https://$front_upstream;")
  })

  test("no connections: only the OAuth paths, every /mcp/c/* refused", () => {
    const none = locations(serverBody(frontServers(HOSTS, { host: IDENTITY, connections: [] }), IDENTITY))
    expect(none.filter((l) => l.exact).map((l) => l.match)).toEqual(KEYSTONE_OAUTH_PATHS.map((p) => p.path))
  })

  test("refuses a Keystone host that is not an egress host, and an invalid id", () => {
    expect(() => frontServers(HOSTS, { host: "rag.alterspective.com.au", connections: CHOSEN })).toThrow()
    expect(() => frontServers(HOSTS, { host: IDENTITY, connections: ["github/../x"] })).toThrow()
    expect(() => frontServers(HOSTS, { host: IDENTITY, connections: ["a { return 200; }"] })).toThrow()
  })
})

describe("routing through the identity server (nginx URI semantics)", () => {
  test("allowed calls are forwarded with exactly their own path", () => {
    expect(route("POST", "/mcp/c/rag-read")).toEqual({ status: 0, upstream: "/mcp/c/rag-read" })
    expect(route("GET", "/mcp/c/github")).toEqual({ status: 0, upstream: "/mcp/c/github" })
    expect(route("DELETE", "/mcp/c/seqlogs")).toEqual({ status: 0, upstream: "/mcp/c/seqlogs" })
    expect(route("GET", "/.well-known/oauth-protected-resource/mcp/c/rag-read")).toEqual({ status: 0, upstream: "/.well-known/oauth-protected-resource/mcp/c/rag-read" })
    expect(route("GET", "/.well-known/oauth-authorization-server")).toEqual({ status: 0, upstream: "/.well-known/oauth-authorization-server" })
    expect(route("POST", "/api/oauth/register")).toEqual({ status: 0, upstream: "/api/oauth/register" })
    expect(route("POST", "/api/oidc/token")).toEqual({ status: 0, upstream: "/api/oidc/token" })
  })

  const refused: Array<[string, string, string]> = [
    ["dynamic relay", "POST", "/mcp/dynamic"],
    ["admin MCP", "POST", "/api/mcp"],
    ["a connection not chosen", "POST", "/mcp/c/m365"],
    ["a prefix of a chosen id", "POST", "/mcp/c/rag"],
    ["a chosen id plus a suffix", "POST", "/mcp/c/github2"],
    ["deeper path under a connection", "POST", "/mcp/c/github/x"],
    ["trailing slash", "POST", "/mcp/c/github/"],
    ["upper case", "POST", "/MCP/C/GITHUB"],
    ["mixed case dynamic", "POST", "/Mcp/Dynamic"],
    ["traversal out of a connection", "POST", "/mcp/c/github/../../mcp/dynamic"],
    ["traversal with encoded dots", "POST", "/mcp/c/github/%2e%2e/%2e%2e/mcp/dynamic"],
    ["traversal with encoded slashes", "POST", "/mcp/c/github%2F..%2F..%2Fdynamic"],
    ["encoded dynamic", "POST", "/mcp/%64ynamic"],
    ["double slashes", "POST", "//mcp//dynamic"],
    ["semicolon path parameter", "POST", "/mcp/c/github;/../../dynamic"],
    ["semicolon suffix", "POST", "/mcp/c/github;x"],
    ["encoded question mark", "POST", "/mcp/c/github%3Fx=1"],
    ["query string on an allowed path", "POST", "/mcp/c/github?x=1"],
    ["query string on discovery", "GET", "/.well-known/oauth-authorization-server?x=1"],
    ["authorize endpoint", "GET", "/api/oauth/authorize"],
    ["another /api path", "GET", "/api/users/me"],
    ["revocation", "POST", "/api/oauth/revoke"],
    ["root protected-resource metadata (/api/mcp's)", "GET", "/.well-known/oauth-protected-resource"],
    ["resource metadata of a connection not chosen", "GET", "/.well-known/oauth-protected-resource/mcp/c/m365"],
    ["resource metadata of dynamic", "GET", "/.well-known/oauth-protected-resource/mcp/dynamic"],
    ["wrong method on the token endpoint", "GET", "/api/oidc/token"],
    ["wrong method on discovery", "POST", "/.well-known/oauth-authorization-server"],
    ["PUT on an MCP endpoint", "PUT", "/mcp/c/github"],
  ]
  for (const [why, method, target] of refused) {
    test(`refused (403/400, nothing forwarded): ${why} — ${method} ${target}`, () => {
      const routed = route(method, target)
      expect({ target, status: routed.status === 400 ? 403 : routed.status, upstream: routed.upstream }).toEqual({ target, status: 403, upstream: undefined })
    })
  }

  test("spellings that normalise INTO an allowed path are forwarded as the literal allowed path, never as typed", () => {
    for (const target of ["/mcp/dynamic/../c/github", "/mcp/c/%67ithub", "//mcp/c/github", "/mcp/./c/github", "/api/../mcp/c/github"])
      expect({ target, ...route("POST", target) }).toEqual({ target, status: 0, upstream: "/mcp/c/github" })
  })

  test("NUL and `..` above the root are bad requests", () => {
    expect(route("POST", "/mcp/c/github%00").status).toBe(400)
    expect(route("POST", "/../mcp/dynamic").status).toBe(400)
  })
})
