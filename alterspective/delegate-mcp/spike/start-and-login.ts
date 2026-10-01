// Dev helper (spike): start or reuse the delegate box with the real supervisor, then run the
// Keystone sign-in for every chosen ks-<id> entry that needs it (R4-01). Leaves the box running. Prints no secrets.
import path from "node:path"
import { currentKeystone, defaultConfig } from "../src/shared/config.ts"
import { entryName } from "../src/shared/keystone.ts"
import { createApi } from "../src/shared/opencode-api.ts"
import { createLogger } from "../src/shared/log.ts"
import { createGuard } from "../src/guard/index.ts"
import { createSupervisor, defaultSupervisorDeps } from "../src/supervisor/lifecycle.ts"
import { login } from "../src/supervisor/login.ts"

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..")
const config = defaultConfig()
const log = createLogger({ minLevel: "info" })
const guard = createGuard(config)
const deps = await defaultSupervisorDeps(config, {
  bridgeId: `dev-${process.pid}`,
  permission: guard.permissionBaseline("standard"),
  repoRoot,
  log,
})
const supervisor = createSupervisor(deps)
const target = await supervisor.ensure()
console.error(`box ready at ${target.baseUrl}`)
const api = createApi(target)
const before = await api.call<Record<string, { status: string }>>({ path: "/mcp", directory: "/sessions" })
console.error("before:", JSON.stringify(before.data))
for (const entry of currentKeystone(config).connections.map(entryName)) {
  if (before.data?.[entry]?.status !== "needs_auth" || process.argv.includes("--no-login")) continue
  const result = await login(api, entry, { authOrigin: config.keystoneOrigin, logger: log })
  console.error(`login ${entry}:`, result)
  if (result !== "connected") break
}
const after = await api.call<Record<string, { status: string }>>({ path: "/mcp", directory: "/sessions" })
console.error("after:", JSON.stringify(after.data))
