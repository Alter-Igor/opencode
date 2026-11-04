import { readFileSync } from "fs"
import path from "path"
import { InstallationChannel } from "./version.js"

const SEMVER_RE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/
function parseSemver(v: string) {
  const m = SEMVER_RE.exec(v.trim())
  if (!m) return undefined
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split(".") : [],
  }
}
function comparePre(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const ai = a[i]
    const bi = b[i]
    if (ai === undefined) return -1
    if (bi === undefined) return 1
    const an = /^\d+$/.test(ai) ? Number(ai) : NaN
    const bn = /^\d+$/.test(bi) ? Number(bi) : NaN
    if (!Number.isNaN(an) && !Number.isNaN(bn)) {
      if (an !== bn) return an > bn ? 1 : -1
    } else if (!Number.isNaN(an)) {
      return -1
    } else if (!Number.isNaN(bn)) {
      return 1
    } else if (ai !== bi) {
      return ai > bi ? 1 : -1
    }
  }
  return 0
}
const semver = {
  valid(v: string): string | null {
    return parseSemver(v) ? v.trim().replace(/^v/, "") : null
  },
  compare(a: string, b: string): number {
    const pa = parseSemver(a)
    const pb = parseSemver(b)
    if (!pa || !pb) return 0
    if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1
    if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1
    if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1
    return comparePre(pa.pre, pb.pre)
  },
  rcompare(a: string, b: string): number {
    return -semver.compare(a, b)
  },
  gt(a: string, b: string): boolean {
    return semver.compare(a, b) > 0
  },
}

export const OPENCODEALT_CHANNEL = "opencodealt"
export const OPENCODEALT_REPO = "Alter-Igor/opencode"
export const OPENCODEALT_TAG_PREFIX = "opencodealt-v"
export const OPENCODEALT_LATEST_RELEASE_URL = `https://api.github.com/repos/${OPENCODEALT_REPO}/releases/latest`
export const OPENCODEALT_RELEASES_URL = `https://api.github.com/repos/${OPENCODEALT_REPO}/releases?per_page=30`
export const OPENCODEALT_DOCS_URL = "https://aio.alterspective.com.au/app/ai-os/opencodealt"
export const OPENCODEALT_UPDATE_COMMAND = ["aio", "opencode", "install"]

export function isOpencodealt(channel = InstallationChannel) {
  return channel === OPENCODEALT_CHANNEL
}

export function opencodealtVersion(tag: string) {
  return tag.startsWith(OPENCODEALT_TAG_PREFIX) ? tag.slice(OPENCODEALT_TAG_PREFIX.length) : tag.replace(/^v/, "")
}

export type OpencodealtReleaseChannel = "stable" | "edge"

export function readOpencodealtChannel(
  execPath = process.execPath,
  env: Record<string, string | undefined> = process.env,
): OpencodealtReleaseChannel {
  const override = env["OPENCODEALT_RELEASE_CHANNEL"]?.trim()
  if (override === "edge" || override === "stable") return override
  try {
    const value = readFileSync(path.join(path.dirname(path.dirname(execPath)), "channel"), "utf8").trim()
    return value === "edge" ? "edge" : "stable"
  } catch {
    return "stable"
  }
}

export function newestOpencodealtVersion(releases: readonly { tag_name: string; draft?: boolean }[]) {
  return releases
    .filter((release) => !release.draft && release.tag_name.startsWith(OPENCODEALT_TAG_PREFIX))
    .map((release) => opencodealtVersion(release.tag_name))
    .filter((version) => semver.valid(version))
    .sort(semver.rcompare)[0]
}

export function isNewerOpencodealt(candidate: string, current: string) {
  return !!semver.valid(candidate) && !!semver.valid(current) && semver.gt(candidate, current)
}

export async function latestOpencodealt(currentVersion?: string): Promise<string> {
  const channel = readOpencodealtChannel()
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": `opencodealt/${currentVersion || "0.0.0"}`,
  }
  if (channel === "edge") {
    try {
      const res = await fetch(OPENCODEALT_RELEASES_URL, { headers })
      if (res.ok) {
        const releases = (await res.json()) as { tag_name: string; draft?: boolean }[]
        const newest = newestOpencodealtVersion(releases)
        if (newest) return newest
      }
    } catch {
      // Fall back to the stable (Latest) check below if the edge releases lookup fails.
    }
  }
  const res = await fetch(OPENCODEALT_LATEST_RELEASE_URL, { headers })
  if (!res.ok) throw new Error(`GitHub latest release HTTP ${res.status}`)
  const data = (await res.json()) as { tag_name?: string }
  if (!data.tag_name) throw new Error("Latest release missing tag_name")
  return opencodealtVersion(data.tag_name)
}

export const Opencodealt = {
  CHANNEL: OPENCODEALT_CHANNEL,
  REPO: OPENCODEALT_REPO,
  DOCS_URL: OPENCODEALT_DOCS_URL,
  INSTALL_COMMAND: OPENCODEALT_UPDATE_COMMAND,
  enabled: isOpencodealt,
  latest: latestOpencodealt,
  readChannel: readOpencodealtChannel,
  newestVersion: newestOpencodealtVersion,
  isNewer: isNewerOpencodealt,
  versionFromTag: opencodealtVersion,
}
