// MOD-01: per-call context for the supervisor (A-17) and this bridge's lease (A-02, A-18).
// Every public call gets a correlation id; every log line carries it and the bridge id.
// Any error that is not already a DelegateError is wrapped, so callers only ever see stable
// codes; paths, errno and stderr go to `detail`, which is logged but never shown (ERR-SPLIT-01).
import { randomUUID } from "node:crypto"
import { DelegateError, isDelegateError, type ErrorCode } from "../shared/errors.ts"
import { silentLogger, type Level, type Logger } from "../shared/log.ts"
import { containerName, paths } from "./compose-env.ts"
import type { ComposeFiles } from "./docker.ts"
import { LEASE_HEARTBEAT_MS, createLeases, type Leases } from "./leases.ts"
import type { SupervisorDeps } from "./lifecycle.ts"
import { ownStartTime, type ProcessRecord } from "./process.ts"
import { LOCK_WAIT_MS, intervalEvery, type LockOptions } from "./start-lock.ts"

type Fields = Record<string, string | number | boolean | undefined>

type State = { startedHere: boolean; leased: boolean; stopLeaseHeartbeat?: () => void; self?: ProcessRecord }

export type Ctx = {
  deps: SupervisorDeps
  log: Logger
  dirs: ReturnType<typeof paths>
  leases: Leases
  compose: ComposeFiles
  container: string
  state: State
}

export type Run = Ctx & {
  cid: string
  note(level: Level, msg: string, fields?: Fields): void
  stopHeartbeat(): void
}

export function createContext(deps: SupervisorDeps): Ctx {
  const dirs = paths(deps.config)
  return {
    deps,
    log: deps.log ?? silentLogger,
    dirs,
    leases: createLeases(deps.leaseFs, dirs.leases, { probe: deps.probe, now: deps.now }),
    compose: { project: deps.config.project, files: [deps.composeFile, dirs.boxEnvOverride] },
    container: containerName(deps.config),
    state: { startedHere: false, leased: false },
  }
}

export function toDelegateError(error: unknown, fallback: ErrorCode = "sandbox_unavailable"): DelegateError {
  if (isDelegateError(error)) return error
  const errno = (error as NodeJS.ErrnoException | undefined)?.code
  const name = error instanceof Error ? error.name : typeof error
  const message = error instanceof Error ? error.message : String(error)
  return new DelegateError(fallback, "The sandbox supervisor hit an unexpected error.", "Run oc_doctor; the bridge log has the details.", `${name}${errno ? ` ${errno}` : ""}: ${message.slice(0, 300)}`)
}

function runOf(ctx: Ctx): Run {
  const cid = randomUUID()
  return {
    ...ctx,
    cid,
    note: (level, msg, fields = {}) => ctx.log.log(level, "supervisor", msg, { bridgeId: ctx.deps.bridgeId, correlationId: cid, ...fields }),
    stopHeartbeat() {
      ctx.state.stopLeaseHeartbeat?.()
      ctx.state.stopLeaseHeartbeat = undefined
    },
  }
}

/** Log the call and its outcome; convert any failure to a DelegateError and log code + detail. */
export async function traced<T>(ctx: Ctx, op: string, fn: (run: Run) => Promise<T>, fallback?: ErrorCode): Promise<T> {
  const run = runOf(ctx)
  const began = ctx.deps.now()
  run.note("info", `${op} called`)
  try {
    const result = await fn(run)
    run.note("info", `${op} done`, { ms: ctx.deps.now() - began })
    return result
  } catch (error) {
    const failure = toDelegateError(error, fallback)
    run.note("error", `${op} failed`, { code: failure.code, detail: failure.detail, ms: ctx.deps.now() - began })
    throw failure
  }
}

export async function selfRecord(run: Run): Promise<ProcessRecord> {
  run.state.self ??= { pid: run.deps.pid, startedAt: run.deps.pid === process.pid ? await ownStartTime(run.deps.probe) : undefined }
  return run.state.self
}

export async function lockOptions(run: Run): Promise<LockOptions> {
  const { deps } = run
  return { now: deps.now, sleep: deps.sleep, probe: deps.probe, self: await selfRecord(run), waitMs: deps.lockWaitMs ?? LOCK_WAIT_MS, every: deps.every }
}

function startLeaseHeartbeat(run: Run, self: ProcessRecord): void {
  if (run.state.stopLeaseHeartbeat) return
  const beat = async () => {
    // A lease pruned by mistake (e.g. after sleep) comes back on the next beat.
    if (!(await run.leases.heartbeat(run.deps.bridgeId))) await run.leases.acquire(run.deps.bridgeId, self)
  }
  run.state.stopLeaseHeartbeat = (run.deps.every ?? intervalEvery)(() => {
    beat().catch((error: unknown) => run.note("warn", "lease heartbeat failed", { detail: toDelegateError(error).detail }))
  }, LEASE_HEARTBEAT_MS)
}

/** Take this bridge's lease before fn (health waits included); drop it again if fn fails and we had none before. */
export async function withLease<T>(run: Run, fn: () => Promise<T>): Promise<T> {
  const had = run.state.leased
  const self = await selfRecord(run)
  await run.leases.acquire(run.deps.bridgeId, self)
  run.state.leased = true
  startLeaseHeartbeat(run, self)
  try {
    return await fn()
  } catch (error) {
    if (!had) {
      run.stopHeartbeat()
      run.state.leased = false
      await run.leases.release(run.deps.bridgeId).catch(() => undefined)
    }
    throw error
  }
}
