// Wave 2 live end-to-end (dev helper): a real session in the box messages its supervisor through
// the inbox while the event hub watches; the bridge reads the message, answers, and waits.
// Uses a scratch /sessions folder (not a git repo) and cleans it up.
import { randomBytes } from "node:crypto"
import path from "node:path"
import { defaultConfig } from "../src/shared/config.ts"
import { createApi } from "../src/shared/opencode-api.ts"
import { createLogger } from "../src/shared/log.ts"
import { createGuard } from "../src/guard/index.ts"
import { createHub } from "../src/events/index.ts"
import { SESSION_SUPERVISOR_KEY, cachedTarget, createInbox, inboxTargetFromDocker } from "../src/inbox/index.ts"
import { createSupervisor, defaultSupervisorDeps } from "../src/supervisor/lifecycle.ts"
import { bunExec } from "../src/supervisor/docker.ts"
import { containerName } from "../src/supervisor/compose-env.ts"

const config = defaultConfig()
const log = createLogger({ minLevel: "warn" })
const guard = createGuard(config)
const repoRoot = path.resolve(import.meta.dir, "..", "..", "..")
const deps = await defaultSupervisorDeps(config, { bridgeId: `e2e2-${process.pid}`, permission: guard.permissionBaseline("standard"), repoRoot, log })
const target = await createSupervisor(deps).ensure()
const api = createApi(target)
const supervisorName = "supervisor:e2e-claude"
const cache = cachedTarget(() => inboxTargetFromDocker(bunExec, config))
const inbox = createInbox({ supervisor: supervisorName, target: cache.target, invalidate: cache.invalidate })
const hub = createHub({ target, log })
await hub.start()

const dir = `/sessions/e2e2-${randomBytes(4).toString("hex")}`
await bunExec(["docker", "exec", containerName(config), "mkdir", "-p", dir])
const created = await api.call<{ id: string }>({
  method: "POST", path: "/session", directory: dir,
  body: { title: "e2e w2", permission: guard.permissionBaseline("standard"), metadata: { [SESSION_SUPERVISOR_KEY]: supervisorName } },
})
const sessionID = created.data!.id
hub.track(sessionID, dir)
console.error("session:", sessionID)
hub.subscribe((e) => console.error(`hub: ${e.type}${e.state ? ":" + e.state : ""} ${e.summary}`))

const before = await inbox.read()
const cursor = hub.cursor()
hub.markSent(sessionID)
await api.call({
  method: "POST", path: `/session/${sessionID}/prompt_async`, directory: dir,
  body: { model: { providerID: "synapse", modelID: "auto" }, parts: [{ type: "text", text: "Use the message_supervisor tool to send exactly this text: 'hello supervisor, task done'. Then reply DONE." }] },
})
const settled = await hub.wait({ sessionIDs: [sessionID], until: ["idle"], timeoutMs: 240_000, cursor })
console.error("wait:", settled.timedOut ? "timed out" : settled.events.map((e) => `${e.type}:${e.state ?? ""}`).join(","))
const page = await inbox.read(before.next)
for (const m of page.messages) console.error(`inbox: from=${m.from} verified=${m.verified} text=${JSON.stringify(m.text).slice(0, 80)}`)
console.error("truncated:", page.truncated ?? false)
const reply = await inbox.post(`session:${sessionID}`, "thanks, received", { correlationId: page.messages[0]?.correlationId })
console.error("reply posted:", reply.verified, reply.from)
console.error("view:", JSON.stringify(await hub.view(sessionID)))

await api.call({ method: "DELETE", path: `/session/${sessionID}`, directory: dir })
await bunExec(["docker", "exec", containerName(config), "rm", "-rf", dir])
await hub.stop()
