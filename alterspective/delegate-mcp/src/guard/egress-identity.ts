// MOD-02 / review R4-01: the Keystone (identity) server in front's generated config allows ONLY the
// paths the box's MCP client needs for the chosen connections; every other path gets 403 from front
// and never reaches Keystone. This is the wall: in-box code holds the OAuth tokens
// (/data/mcp-auth.json) and can skip OpenCode, so OpenCode's own checks do not stop it reaching
// /mcp/dynamic (every service on the owner's account) or /api/*.
//
// Where the paths come from (checked 2026-10-01, MCP SDK 1.29.0 client/auth.js and Keystone's
// public discovery documents):
// - /mcp/c/<id>: the streamable-HTTP transport (POST messages, GET event stream, DELETE session end).
// - /.well-known/oauth-protected-resource/mcp/c/<id>: RFC 9728 metadata. Keystone's 401 names this
//   exact URL in WWW-Authenticate (resource_metadata), and the SDK's path-aware lookup builds it too.
// - /.well-known/oauth-authorization-server, then /.well-known/openid-configuration (SDK fallback
//   order for an issuer with no path): Keystone's authorization server metadata.
// - /api/oauth/register: registration_endpoint (dynamic client registration).
// - /api/oidc/token: token_endpoint (code exchange and refresh).
// The authorization_endpoint (/api/oauth/authorize) is opened in the OWNER's browser, not by the
// box, so it is not allowed here. /mcp/dynamic, /api/mcp and every other /api/* path get 403.
//
// Matching: nginx matches `location =` against the NORMALISED URI (percent-decoded, `.`/`..`
// resolved, `//` merged), case-sensitively. A plain `proxy_pass https://host` would then forward
// the RAW request URI, which could differ from what was matched. So each location proxies a
// LITERAL path, the one it matched: whatever spelling the box used, Keystone receives exactly the
// allowed path. Query strings are refused (none of these calls uses one), so nothing rides along.
import { keystoneIds } from "../shared/keystone.ts"

export type IdentityPath = { path: string; methods: readonly string[] }

/** Keystone's OAuth endpoints the box's MCP client calls (see the header for the sources). */
export const KEYSTONE_OAUTH_PATHS: readonly IdentityPath[] = [
  { path: "/.well-known/oauth-authorization-server", methods: ["GET"] },
  { path: "/.well-known/openid-configuration", methods: ["GET"] },
  { path: "/api/oauth/register", methods: ["POST"] },
  { path: "/api/oidc/token", methods: ["POST"] },
]

/** Every path front lets the box reach on Keystone for these connection ids. */
export function identityPaths(connections: readonly string[]): IdentityPath[] {
  const perConnection = keystoneIds(connections).flatMap((id): IdentityPath[] => [
    { path: `/.well-known/oauth-protected-resource/mcp/c/${id}`, methods: ["GET"] },
    { path: `/mcp/c/${id}`, methods: ["GET", "POST", "DELETE"] },
  ])
  return [...KEYSTONE_OAUTH_PATHS, ...perConnection]
}

/** One exact-match location that forwards only its own literal path. `host` is already validated. */
function location(host: string, allowed: IdentityPath): string[] {
  return [
    `    location = ${allowed.path} {`,
    `        limit_except ${allowed.methods.join(" ")} { deny all; }`,
    "        if ($is_args) { return 403; }",
    `        set $front_upstream "${host}";`,
    `        proxy_pass https://$front_upstream${allowed.path};`,
    `        proxy_ssl_name ${host};`,
    `        proxy_set_header Host ${host};`,
    "        include /etc/nginx/front/upstream.conf;",
    "    }",
  ]
}

/** The location blocks of the identity server: refuse by default, then one exact location per allowed path. */
export function identityLocations(host: string, connections: readonly string[]): string[] {
  return [
    "    # R4-01: only the paths the box's MCP client needs for the chosen Keystone connections.",
    "    # Anything else (/mcp/dynamic, /api/mcp, other connections) is refused here.",
    "    location / {",
    "        return 403;",
    "    }",
    ...identityPaths(connections).flatMap((allowed) => location(host, allowed)),
  ]
}
