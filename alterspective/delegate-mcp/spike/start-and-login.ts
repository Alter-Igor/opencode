// Dev helper (spike): start or reuse the delegate box with the real supervisor, then run the
// Keystone sign-in for ks-delegate. Leaves the box running. Prints no secrets.
import path from "node:path"
import { defaultConfig } from "../src/shared/config.ts"
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
if (before.data?.["ks-delegate"]?.status !== "connected" && !process.argv.includes("--no-login")) {
  const result = await login(api, "ks-delegate", { logger: log })
  console.error("login:", result)
}
const after = await api.call<Record<string, { status: string }>>({ path: "/mcp", directory: "/sessions" })
console.error("after:", JSON.stringify(after.data))
