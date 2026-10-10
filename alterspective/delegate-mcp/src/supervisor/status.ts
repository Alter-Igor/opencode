// MOD-01: Supervisor.status (A-11, A-05). Never throws: any failure is reported as
// { state: "unavailable", reason } and logged with its code and detail.
// The running state also says whether the box's MCP allow policy (the fork patch input) and
// image match this bridge, and the Docker health status.
import { effectiveConfig, mcpAllowPolicy, type KeystoneConfig } from "../shared/config.ts"
import type { BoxState, Supervisor } from "../shared/contracts.ts"
import { DelegateError, isDelegateError } from "../shared/errors.ts"
import { readKeystoneSet } from "../shared/keystone.ts"
import { ceilingOf } from "../shared/keystone-policy.ts"
import type { ApiTarget } from "../shared/opencode-api.ts"
import { INSPECT_ENV, MCP_ALLOW_ENV, PASSWORD_ENV } from "./compose-env.ts"
import { LABEL, builtFrom, inspectBox, requireDocker, type BoxInspect } from "./docker.ts"
import type { LiveChecks } from "./live.ts"
import { frontFilesFor } from "./plan.ts"
import { toDelegateError, type Run } from "./run.ts"

type Running = Extract<BoxState, { state: "running" }>

/** BoxState plus supervisor detail. Assignable to BoxState; the hub may widen contracts.ts to match. */
export type SupervisorStatus =
  | Exclude<BoxState, { state: "running" }>
  | (Running & {
      health: BoxInspect["health"]
      /** OPENCODE_MCP_ALLOW in the box equals mcpAllowPolicy for the Keystone set in force now. */
      policyVerified: boolean
      /** The running front was started with the servers file for the Keystone set in force now (R4-01). */
      frontMatches: boolean
      /** The box was built from the same build inputs (image label = content-hash tag) as this bridge wants. */
      imageMatches: boolean
      /** Information only: the git sha baked into the image when it was built (`<sha>[+dirty.<hash>]`). */
      imageBuiltFrom?: string
      /** Information only: the git sha of the checkout this bridge runs from. */
      bridgeAt?: string
      /**
       * The box runs a Keystone set whose ids leave this bridge's ceiling (R5-03), so this bridge
       * cannot use it. The box is still running (health, image and startedBy are truthful); only
       * the policy and front comparisons are forced to false because they cannot be computed.
       */
      ceilingMismatch?: string[]
    })

/** `keystone`: a new box-wide Keystone set (connection ids), saved in the bridge home (R4-01). */
export type ReplaceOptions = { force: boolean; keystone?: string[] }
/** `interrupted`: how many other bridges held the running sandbox that was replaced. `keystone`: the set it runs with. */
export type ReplaceResult = { target: ApiTarget; interrupted: number; keystone: string[] }

export interface DelegateSupervisor extends Supervisor {
  status(): Promise<SupervisorStatus>
  /**
   * Stop the sandbox (compose down, never -v) and start it with this bridge's profile and image,
   * under the start lock. Refused with profile_changed while other bridges hold it, unless force.
   */
  replace(options: ReplaceOptions): Promise<ReplaceResult>
  /** oc_doctor (R5-01, R5-05): the running box's sign-in store and front's loaded config and mounts. Never throws. */
  verifyLive(): Promise<LiveChecks>
}

export function targetOf(box: BoxInspect, project: string): ApiTarget {
  const password = box.env[PASSWORD_ENV]
  const port = Number(box.labels[LABEL.port])
  if (!password || !Number.isInteger(port) || port <= 0 || port > 65535)
    throw new DelegateError(
      "sandbox_unavailable",
      "The running sandbox is missing its bridge settings.",
      `Restart the sandbox with oc_server_restart (or \`docker compose -p ${project} down\`) and retry.`,
      `password env ${password ? "present" : "missing"}, port label ${box.labels[LABEL.port] === undefined ? "missing" : "invalid"}`,
    )
  return { baseUrl: `http://127.0.0.1:${port}`, password }
}

/** The saved set's ids outside this bridge's ceiling (read + ceiling only, never the enforce). */
function savedOutsideCeiling(config: KeystoneConfig): string[] {
  try {
    const ceiling = ceilingOf(config)
    return readKeystoneSet(config.home, config.keystoneConnections).connections.filter((id) => !ceiling.includes(id))
  } catch {
    return []
  }
}

export async function statusOf(run: Run): Promise<SupervisorStatus> {
  const { deps } = run
  try {
    await requireDocker(deps.exec)
    const box = await inspectBox(deps.exec, INSPECT_ENV, run.container)
    if (!box?.running) return { state: "stopped" }
    const image = box.labels[LABEL.image]
    const front = await inspectBox(deps.exec, [], `${run.container}-front`)
    const base = {
      state: "running" as const,
      imageTag: image ?? box.image,
      startedBy: run.state.startedHere ? ("this-bridge" as const) : ("other" as const),
      health: box.health,
      imageMatches: image === deps.image,
      imageBuiltFrom: builtFrom(box.labels),
      bridgeAt: deps.buildSha,
    }
    let config
    try {
      config = effectiveConfig(deps.config)
      const target = targetOf(box, deps.config.project)
      return {
        ...base,
        target,
        policyVerified: box.env[MCP_ALLOW_ENV] === mcpAllowPolicy(config),
        frontMatches: front?.labels[LABEL.frontConfig] === frontFilesFor(config).hash,
      }
    } catch (error) {
      // The box is running, but this bridge's ceiling excludes the saved set (R5-03): the box is
      // not dead, it is unusable by this bridge (live-verified 2026-10-10). Say so; a policy
      // violation is the only error that means "running but mismatched" — a missing bridge setting
      // or any other failure still reads as an unavailable box. The comparisons cannot be computed,
      // so they fail closed to false.
      if (isDelegateError(error) && error.code === "policy_violation") {
        const outside = savedOutsideCeiling(deps.config)
        const target = targetOf(box, deps.config.project)
        return { ...base, target, policyVerified: false, frontMatches: false, ...(outside.length > 0 ? { ceilingMismatch: outside } : {}) }
      }
      throw error
    }
  } catch (error) {
    const failure = toDelegateError(error)
    run.note("warn", "status unavailable", { code: failure.code, detail: failure.detail })
    return { state: "unavailable", reason: failure.message }
  }
}
