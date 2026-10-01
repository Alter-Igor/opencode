// R5-05: compare the immutable generation attested by a RUNNING worker, and live mount modes.
// Labels and nginx -T only describe requested/on-disk config, not what the worker loaded.
// Every check fails closed and names why. Output read here is from our own containers, but the
// box's mounts are compared against a fixed list, never echoed beyond their destination.
import { createHash } from "node:crypto"
import { FRONT_GENERATED_MOUNT } from "../guard/egress.ts"
import type { Exec } from "./docker.ts"
import { readFrontGeneration } from "./front-generation.ts"

export type Mount = { Destination?: unknown; RW?: unknown; Type?: unknown; Name?: unknown; Driver?: unknown }
/** `docker volume inspect` Options per volume name; undefined when that inspect failed. */
export type VolumeOptions = Record<string, Record<string, string> | null | undefined>
export type FrontLive = { ok: boolean; loadedConfigMatches: boolean; mountReadOnly: boolean; boxMountsOk: boolean; problems: string[] }

/** The box's mounts (docker/compose.yaml) and whether each may be written. Nothing else may appear. */
const BOX_MOUNTS: Record<string, boolean> = { "/data": true, "/sessions": true, "/handoff/in": false, "/handoff/out": true, "/profile": false, "/etc/ocd-front-ca": false }

const sha = (text: string) => createHash("sha256").update(text).digest("hex")

function frontMountProblems(front: Mount[] | undefined): string[] {
  if (!front) return ["front's mounts could not be read from docker inspect"]
  const gen = front.find((mount) => mount.Destination === FRONT_GENERATED_MOUNT)
  if (!gen) return [`front has no mount at ${FRONT_GENERATED_MOUNT}`]
  return gen.RW === false ? [] : [`front's ${FRONT_GENERATED_MOUNT} is mounted read-write`]
}

/**
 * G-7 (review L4): a writable volume must be a plain `local` volume. A local volume made with
 * `-o o=bind,device=<host path>` (or any `device`) is a host folder in disguise.
 */
function volumeProblems(mount: Mount, destination: string, volumes: VolumeOptions): string[] {
  if (mount.Driver !== "local") return [`the box's ${destination} volume uses driver ${String(mount.Driver).slice(0, 30)}, not local`]
  const name = typeof mount.Name === "string" ? mount.Name : ""
  const options = volumes[name]
  if (options === undefined) return [`the box's ${destination} volume could not be inspected`]
  if (options && (options.device !== undefined || (options.o ?? "").includes("bind"))) return [`the box's ${destination} volume is backed by a host folder (bind or device option)`]
  return []
}

function boxMountProblems(box: Mount[] | undefined, volumes: VolumeOptions): string[] {
  if (!box) return ["the box's mounts could not be read from docker inspect"]
  const problems: string[] = []
  const seen = new Set<string>()
  for (const mount of box) {
    const destination = typeof mount.Destination === "string" ? mount.Destination.slice(0, 80) : "(unknown)"
    seen.add(destination)
    if (!(destination in BOX_MOUNTS)) problems.push(`the box has an unexpected mount at ${destination}`)
    else if (BOX_MOUNTS[destination] === false && mount.RW !== false) problems.push(`the box's ${destination} is mounted read-write`)
    // G-7: the box may write named volumes only, never a host folder.
    else if (mount.Type !== "volume" && mount.RW !== false) problems.push(`the box's ${destination} is a writable ${typeof mount.Type === "string" ? mount.Type.slice(0, 20) : "unknown"} mount, not a box-only volume`)
    else if (mount.RW !== false) problems.push(...volumeProblems(mount, destination, volumes))
  }
  for (const destination of Object.keys(BOX_MOUNTS)) if (!seen.has(destination)) problems.push(`the box has no mount at ${destination}`)
  return problems
}

/** Live mount modes: front's generated folder read-only; the box has exactly its own mounts. */
export function checkMounts(front: Mount[] | undefined, box: Mount[] | undefined, volumes: VolumeOptions): { mountReadOnly: boolean; boxMountsOk: boolean; problems: string[] } {
  const frontProblems = frontMountProblems(front)
  const boxProblems = boxMountProblems(box, volumes)
  return { mountReadOnly: frontProblems.length === 0, boxMountsOk: boxProblems.length === 0, problems: [...frontProblems, ...boxProblems] }
}

export type FrontLiveInput = { loaded: string | undefined; expected: string; frontMounts: Mount[] | undefined; boxMounts: Mount[] | undefined; boxVolumes: VolumeOptions }

export function frontLiveFrom(input: FrontLiveInput): FrontLive {
  const problems: string[] = []
  const loaded = input.loaded
  if (loaded === undefined) problems.push("front's running worker did not attest a readable, matching generation; the loaded config is unknown")
  const loadedConfigMatches = loaded !== undefined && loaded === input.expected
  if (loaded !== undefined && !loadedConfigMatches)
    problems.push(`front's loaded servers.conf (sha256 ${sha(loaded).slice(0, 12)}) is not the one generated for the chosen Keystone set (${sha(input.expected).slice(0, 12)}); restart the sandbox with oc_server_restart`)
  const mounts = checkMounts(input.frontMounts, input.boxMounts, input.boxVolumes)
  problems.push(...mounts.problems)
  return { ok: loadedConfigMatches && mounts.mountReadOnly && mounts.boxMountsOk, loadedConfigMatches, mountReadOnly: mounts.mountReadOnly, boxMountsOk: mounts.boxMountsOk, problems }
}

async function mountsOf(exec: Exec, container: string): Promise<Mount[] | undefined> {
  const result = await exec(["docker", "inspect", "--type", "container", "--format", "{{json .Mounts}}", container], { timeoutMs: 20_000 })
  if (result.code !== 0) return undefined
  try {
    const parsed = JSON.parse(result.stdout.trim()) as unknown
    return Array.isArray(parsed) ? (parsed as Mount[]) : undefined
  } catch {
    return undefined
  }
}

/** Options of each writable volume the box mounts (read-only `docker volume inspect`). */
async function volumeOptionsOf(exec: Exec, mounts: Mount[] | undefined): Promise<VolumeOptions> {
  const names = (mounts ?? []).flatMap((m) => (m.Type === "volume" && m.RW !== false && typeof m.Name === "string" ? [m.Name] : []))
  const inspect = async (name: string): Promise<[string, Record<string, string> | null | undefined]> => {
    const result = await exec(["docker", "volume", "inspect", "--format", "{{json .Options}}", name], { timeoutMs: 20_000 })
    try {
      return [name, result.code === 0 ? (JSON.parse(result.stdout.trim()) as Record<string, string> | null) : undefined]
    } catch {
      return [name, undefined]
    }
  }
  return Object.fromEntries(await Promise.all(names.map(inspect)))
}

/** Read front's loaded config and both containers' mounts, and compare with `expected` (the generated servers file). */
export async function readFrontLive(exec: Exec, box: string, expected: string): Promise<FrontLive> {
  const front = `${box}-front`
  const generation = await readFrontGeneration(exec, front)
  const boxMounts = await mountsOf(exec, box)
  const boxVolumes = await volumeOptionsOf(exec, boxMounts)
  return frontLiveFrom({ loaded: generation?.servers, expected, frontMounts: await mountsOf(exec, front), boxMounts, boxVolumes })
}
