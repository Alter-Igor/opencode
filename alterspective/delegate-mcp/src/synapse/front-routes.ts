// WS2 (#48, review H1): the ONLY Synapse routes front forwards, with the owner's token, for the box.
// The owner may hold a Synapse admin role, so the token can reach the operator, fleet, judgment and
// spend planes (Synapse apps/synapse-api/src/auth.ts). front therefore allows exact model paths
// only; every other path gets 403 from front and never leaves it with a credential.
//
// Where the paths come from (checked 2026-10-01): the box's `synapse` provider is
// @ai-sdk/openai-compatible with baseURL https://synapse2-api.alterspective.com.au/v1, and the fork
// plugin (packages/opencode/src/plugin/synapse.ts) adds no fetch of its own when the box holds no
// stored auth (its loader returns baseURL + headers only). The SDK's chat model posts to
// `${baseURL}/chat/completions`. OpenCode does not fetch the model list in the box
// (OPENCODE_DISABLE_MODELS_FETCH=1); GET /v1/models is allowed because it is a read-only list a
// delegated user may always call (playbook §8) and lets in-box code see what `auto` can route to.
// No embeddings, responses, usage, fleet, operator, judgment, health or MCP route is allowed.
import { AUTH_FILE_NAME, AUTH_VAR } from "./auth-conf.ts"

export type SynapseRoute = { path: string; methods: readonly string[] }

export const SYNAPSE_ROUTES: readonly SynapseRoute[] = [
  { path: "/v1/chat/completions", methods: ["POST"] },
  { path: "/v1/models", methods: ["GET"] },
]

/** The synapse server's locations: refuse by default (no token), then one exact location per route. */
export function synapseLocations(host: string, includeDir: string): string[] {
  return [
    "    # WS2 (#48, H1): only the model routes OpenCode uses. Anything else (usage, fleet, operator,",
    "    # judgments, health, MCP) is refused here and never gets the owner's token.",
    "    location / {",
    "        return 403;",
    "    }",
    ...SYNAPSE_ROUTES.flatMap((route) => routeLocation(host, includeDir, route)),
  ]
}

function routeLocation(host: string, includeDir: string, route: SynapseRoute): string[] {
  return [
    `    location = ${route.path} {`,
    `        limit_except ${route.methods.join(" ")} { deny all; }`,
    "        if ($is_args) { return 403; }",
    `        set $front_upstream "${host}";`,
    "        # The box holds no Synapse credential: front drops the box's own and sends the owner's",
    "        # delegated token, which the bridge keeps in the include (refreshed on the host).",
    `        set ${AUTH_VAR} "";`,
    `        include ${includeDir}/${AUTH_FILE_NAME};`,
    `        proxy_set_header Authorization ${AUTH_VAR};`,
    '        proxy_set_header x-api-key "";',
    `        proxy_pass https://$front_upstream${route.path};`,
    `        proxy_ssl_name ${host};`,
    `        proxy_set_header Host ${host};`,
    "        include /etc/nginx/front/upstream.conf;",
    "    }",
  ]
}

/** `location` lines of one server block, as written (for the doctor's live route check). */
export function locationLines(serverBlock: string): string[] {
  return serverBlock.split("\n").filter((line) => /^ {4}location /.test(line)).map((line) => line.trim())
}

/** The location lines the synapse server must have, exactly. */
export const expectedSynapseLocations = () => ["location / {", ...SYNAPSE_ROUTES.map((route) => `location = ${route.path} {`)]
