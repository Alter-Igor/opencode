// FEAT-OCD-001 MOD-05: where the inbox admin API is. The admin token is generated per box start
// (lifecycle.ts) and exists only in bridge memory and in the INBOX container's env, so any bridge
// reads it back with `docker inspect <project>-inbox` (needs the owner's Docker access, not a file
// the agent can read), together with the host port label. The result is cached in memory.
import type { BridgeConfig } from "../shared/config.ts"
import { DelegateError, isDelegateError } from "../shared/errors.ts"
import { INBOX_ADMIN_TOKEN_ENV, INBOX_PORT_LABEL, containerName } from "../supervisor/compose-env.ts"
import { inspectBox, type BoxInspect, type Exec } from "../supervisor/docker.ts"
import type { InboxTarget } from "./client.ts"

export function inboxContainer(config: Pick<BridgeConfig, "project">): string {
  return `${containerName(config)}-inbox`
}

function notRunning(project: string, detail: string): DelegateError {
  return new DelegateError(
    "inbox_unavailable",
    "The agent inbox is not running.",
    `It starts with the sandbox: run oc_doctor, or restart the sandbox (\`docker compose -p ${project} down\` then retry).`,
    detail,
  )
}

export async function inboxTargetFromDocker(exec: Exec, config: Pick<BridgeConfig, "project">): Promise<InboxTarget> {
  const name = inboxContainer(config)
  let inspected: BoxInspect | undefined
  try {
    inspected = await inspectBox(exec, [INBOX_ADMIN_TOKEN_ENV], name)
  } catch (error) {
    throw notRunning(config.project, isDelegateError(error) ? `${error.code}: ${error.detail ?? ""}`.slice(0, 300) : "inspect failed")
  }
  if (!inspected?.running) throw notRunning(config.project, inspected ? "container stopped" : "container missing")
  const token = inspected.env[INBOX_ADMIN_TOKEN_ENV]
  const port = Number(inspected.labels[INBOX_PORT_LABEL])
  if (!token || !Number.isInteger(port) || port <= 0 || port > 65535)
    throw notRunning(config.project, `token env ${token ? "present" : "missing"}, port label ${inspected.labels[INBOX_PORT_LABEL] === undefined ? "missing" : "invalid"}`)
  return { baseUrl: `http://127.0.0.1:${port}`, token }
}

/** Resolve once and keep it in memory; `invalidate` forgets it (after a 401 or a box restart). */
export function cachedTarget(resolve: () => Promise<InboxTarget>): { target: () => Promise<InboxTarget>; invalidate: () => void } {
  let pending: Promise<InboxTarget> | undefined
  return {
    target: () => {
      pending ??= resolve().catch((error: unknown) => {
        pending = undefined
        throw error
      })
      return pending
    },
    invalidate: () => {
      pending = undefined
    },
  }
}
