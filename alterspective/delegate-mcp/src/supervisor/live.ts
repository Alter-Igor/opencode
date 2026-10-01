// R5-01 + R5-05: checks against the RUNNING sandbox, not its labels.
// - pruneSignIns: on every start, reuse and set change, remove from the box's MCP sign-in store
//   every entry that is not a current `ks-<id>` (auth-store.ts), and record what was removed.
// - verifyLive (oc_doctor): the store holds only current entries, and front runs the generated
//   config with the generated folder read-only (front-live.ts). Never throws: a failure is a
//   failed check with a reason.
import { effectiveConfig } from "../shared/config.ts"
import { entryName } from "../shared/keystone.ts"
import { readPruned, recordPruned, runAuthStore, type PrunedRecord } from "./auth-store.ts"
import { readFrontLive, type FrontLive } from "./front-live.ts"
import { frontFilesFor, type Plan } from "./plan.ts"
import { toDelegateError, type Run } from "./run.ts"

export type SignInCheck = {
  ok: boolean
  /** Entry names in the box's store (names only, never tokens). */
  names: string[]
  /** Stored entries that are not a current ks-<id>. */
  stale: string[]
  /** Store keys that are not plain names (counted, never shown). */
  unrecognised: number
  /** Entries the bridge removed earlier. Keystone cannot revoke them for the bridge: the owner revokes by client id. */
  removedBefore: PrunedRecord[]
}
export type LiveChecks = { ok: boolean; signIns: SignInCheck; front: FrontLive; problems: string[] }

/** Remove sign-ins outside `plan`'s set. Throws policy_unverified when the store cannot be cleaned (fails closed). */
export async function pruneSignIns(run: Run, plan: Pick<Plan, "config">): Promise<void> {
  const keep = plan.config.keystoneConnections.map(entryName)
  const result = await runAuthStore(run.deps.exec, run.container, "prune", keep)
  if (result.removed.length === 0) return
  const names = result.removed.map((entry) => entry.name)
  run.note("warn", "removed stored sign-ins outside the chosen Keystone set", { names: names.join(","), count: names.length })
  try {
    recordPruned(run.deps.config.home, result.removed, new Date(run.deps.now()).toISOString())
  } catch (error) {
    run.note("warn", "could not record the removed sign-ins", { detail: toDelegateError(error).detail })
  }
}

async function signIns(run: Run, keep: string[]): Promise<SignInCheck> {
  const removedBefore = readPruned(run.deps.config.home)
  const store = await runAuthStore(run.deps.exec, run.container, "list")
  const stale = store.names.filter((name) => !keep.includes(name))
  return { ok: stale.length === 0 && store.unrecognised === 0, names: store.names, stale, unrecognised: store.unrecognised, removedBefore }
}

const failedSignIns = (home: string): SignInCheck => ({ ok: false, names: [], stale: [], unrecognised: 0, removedBefore: readPruned(home) })
const failedFront = (why: string): FrontLive => ({ ok: false, loadedConfigMatches: false, mountReadOnly: false, boxMountsOk: false, problems: [why] })

function problemsOf(sign: SignInCheck, front: FrontLive): string[] {
  const problems: string[] = []
  if (sign.stale.length) problems.push(`stored sign-ins outside the chosen set: ${sign.stale.join(", ").slice(0, 200)}`)
  if (sign.unrecognised) problems.push(`${sign.unrecognised} stored sign-in name(s) not recognised`)
  return [...problems, ...front.problems]
}

/** The store check, or a failed one with the reason (a store that cannot be read is not verified). */
async function signInsOrFailed(run: Run, keep: string[]): Promise<{ check: SignInCheck; problem?: string }> {
  try {
    return { check: await signIns(run, keep) }
  } catch (error) {
    return { check: failedSignIns(run.deps.config.home), problem: toDelegateError(error).message }
  }
}

export async function verifyLive(run: Run): Promise<LiveChecks> {
  let config
  try {
    config = effectiveConfig(run.deps.config)
  } catch (error) {
    const why = toDelegateError(error).message
    return { ok: false, signIns: failedSignIns(run.deps.config.home), front: failedFront(why), problems: [why] }
  }
  const sign = await signInsOrFailed(run, config.keystoneConnections.map(entryName))
  const front = await readFrontLive(run.deps.exec, run.container, frontFilesFor(config).servers).catch((error: unknown) => failedFront(toDelegateError(error).message))
  const problems = [...(sign.problem ? [sign.problem] : []), ...problemsOf(sign.check, front)]
  return { ok: sign.check.ok && front.ok, signIns: sign.check, front, problems }
}
