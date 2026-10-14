// #171: when a generation has no live bridge and its session is idle, copy the git work onto the
// project this process holds. The caller's session id stays on the host record. The chat stays in
// the old box's /data volume; only /sessions/<key> (the clone) is copied.
import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { SESSION_SUPERVISOR_KEY } from "../inbox/index.ts"
import { createApi } from "../shared/opencode-api.ts"
import { PASSWORD_ENV, paths } from "./compose-env.ts"
import { inspectBox, type Exec } from "./docker.ts"
import { createLeases } from "./leases.ts"
import type { Run } from "./run.ts"
import { targetOf } from "./status.ts"
import { listHostStates, SESSION_ID_RE, SESSION_KEY, updateHostState, type HostSessionState } from "./workspaces-state.ts"

const SESSIONS = "/sessions"

/** Idle sessions are absent from GET /session/status. A missing or busy entry is not idle. */
export function sessionIsIdle(status: unknown, sessionID: string): boolean {
  if (!status || typeof status !== "object" || Array.isArray(status)) return false
  return (status as Record<string, unknown>)[sessionID] === undefined
}

/** True when a permission or question list names this session. An unreadable list is treated as pending. */
export function sessionIsPending(data: unknown, sessionID: string): boolean {
  if (!Array.isArray(data)) return true
  return data.some((item) => !!item && typeof item === "object" && (item as { sessionID?: unknown }).sessionID === sessionID)
}

async function liveLeases(run: Run, project: string): Promise<number> {
  const dir = paths({ ...run.deps.config, project }).leases
  const leases = createLeases(run.deps.leaseFs, dir, { probe: run.deps.probe, now: run.deps.now })
  return (await leases.active()).length
}

async function copyClone(exec: Exec, from: string, to: string, key: string, hostDir: string): Promise<boolean> {
  const landed = path.join(hostDir, key)
  await rm(landed, { recursive: true, force: true })
  const out = await exec(["docker", "cp", `${from}:${SESSIONS}/${key}`, hostDir], { timeoutMs: 120_000 })
  if (out.code !== 0) return false
  const into = await exec(["docker", "cp", landed, `${to}:${SESSIONS}/${key}`], { timeoutMs: 120_000 })
  await rm(landed, { recursive: true, force: true })
  if (into.code !== 0) await removeClone(exec, to, key)
  return into.code === 0
}

async function removeClone(exec: Exec, container: string, key: string): Promise<void> {
  if (!SESSION_KEY.test(key)) return
  await exec(["docker", "exec", container, "rm", "-rf", "--", `${SESSIONS}/${key}`], { timeoutMs: 30_000 }).catch(() => undefined)
}

async function undoOpen(run: Run, key: string, sessionID: string): Promise<void> {
  const box = await inspectBox(run.deps.exec, [PASSWORD_ENV], run.container).catch(() => undefined)
  if (box?.running) {
    const api = createApi(targetOf(box, run.deps.config.project), run.deps.fetch)
    await api.call({ method: "DELETE", path: `/session/${sessionID}`, directory: `${SESSIONS}/${key}` }).catch(() => undefined)
  }
  await removeClone(run.deps.exec, run.container, key)
}

async function idleOn(run: Run, project: string, sessionID: string, directory: string): Promise<boolean> {
  const box = await inspectBox(run.deps.exec, [PASSWORD_ENV], project)
  if (!box) return true
  if (!box.running) return true
  let target: ReturnType<typeof targetOf>
  try {
    target = targetOf(box, project)
  } catch {
    return false
  }
  const api = createApi(target, run.deps.fetch)
  const status = await api.call<unknown>({ path: "/session/status", directory }).catch(() => undefined)
  if (!status || status.status !== 200 || !sessionIsIdle(status.data, sessionID)) return false
  const permission = await api.call<unknown>({ path: "/permission", directory }).catch(() => undefined)
  const question = await api.call<unknown>({ path: "/question", directory }).catch(() => undefined)
  if (!permission || permission.status !== 200 || !question || question.status !== 200) return false
  return !sessionIsPending(permission.data, sessionID) && !sessionIsPending(question.data, sessionID)
}

async function openOnNew(run: Run, state: HostSessionState & { sessionID: string }, directory: string): Promise<string | undefined> {
  const box = await inspectBox(run.deps.exec, [PASSWORD_ENV], run.container)
  if (!box?.running) return undefined
  const target = targetOf(box, run.deps.config.project)
  const permission = run.deps.sessionPermission
    ? run.deps.sessionPermission(state.profile === "readonly" ? "readonly" : "standard", state.keystone)
    : run.deps.permission
  const api = createApi(target, run.deps.fetch)
  const created = await api.call<{ id?: unknown }>({
    method: "POST",
    path: "/session",
    directory,
    body: {
      title: `delegate ${state.sessionKey}`,
      permission,
      metadata: { [SESSION_SUPERVISOR_KEY]: state.supervisor, sessionKey: state.sessionKey },
    },
  }).catch(() => undefined)
  const id = created?.data?.id
  if (!created || created.status < 200 || created.status >= 300 || typeof id !== "string" || !SESSION_ID_RE.test(id)) return undefined
  return id
}

async function moveOne(run: Run, state: HostSessionState & { sessionID: string }, hostDir: string): Promise<boolean> {
  const directory = `${SESSIONS}/${state.sessionKey}`
  if (!(await idleOn(run, state.boxProject!, state.sessionID, directory))) return false
  const copied = await copyClone(run.deps.exec, state.boxProject!, run.container, state.sessionKey, hostDir)
  if (!copied) return false
  const boxSessionID = await openOnNew(run, state, directory)
  if (!boxSessionID) {
    await removeClone(run.deps.exec, run.container, state.sessionKey)
    return false
  }
  try {
    updateHostState(path.join(run.deps.config.home, "workspaces"), state.sessionKey, { boxProject: run.deps.config.project, boxSessionID })
  } catch (error) {
    await undoOpen(run, state.sessionKey, boxSessionID)
    throw error
  }
  run.note("info", "moved idle session onto this sandbox", { sessionKey: state.sessionKey, from: state.boxProject })
  return true
}

/** Copy idle sessions off projects whose bridges are gone. A live lease or a running turn stays put. */
export async function relocateIdle(run: Run, projects: readonly string[]): Promise<void> {
  const here = run.deps.config.project
  const wanted = new Set(projects.filter((project) => project !== here))
  if (wanted.size === 0) return
  const held = new Set<string>()
  for (const project of wanted) {
    if ((await liveLeases(run, project).catch(() => 1)) > 0) held.add(project)
  }
  const states = listHostStates(path.join(run.deps.config.home, "workspaces"), Number.POSITIVE_INFINITY).filter(
    (state): state is HostSessionState & { sessionID: string } =>
      state.sessionID !== undefined && state.boxProject !== undefined && wanted.has(state.boxProject) && !held.has(state.boxProject) && SESSION_KEY.test(state.sessionKey),
  )
  if (states.length === 0) return
  const hostDir = path.join(run.dirs.handoff, "incoming")
  await mkdir(hostDir, { recursive: true })
  for (const state of states) {
    if (state.boxSessionID && state.boxProject === here) continue
    await moveOne(run, state, hostDir).catch((error: unknown) => {
      run.note("warn", "idle session was not moved", { sessionKey: state.sessionKey, detail: error instanceof Error ? error.message.slice(0, 200) : "unknown" })
    })
  }
}

