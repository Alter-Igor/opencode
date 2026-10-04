import { readFileSync } from "fs"
import path from "path"
import semver from "semver"
import { InstallationChannel } from "@opencode-ai/core/installation/version"

// Fork-only (#90): opencodealt release builds (`OPENCODE_CHANNEL=opencodealt`) come from this
// repo's GitHub releases and are installed by AI Office (`aio opencode install`). They must
// never check, or install, upstream `opencode-ai`.

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

/** `opencodealt-v1.18.31-alt.7` → `1.18.31-alt.7` */
export function opencodealtVersion(tag: string) {
  return tag.startsWith(OPENCODEALT_TAG_PREFIX) ? tag.slice(OPENCODEALT_TAG_PREFIX.length) : tag.replace(/^v/, "")
}

// Fork-only (#97): two release channels. "stable" is the GitHub Latest release (an edge
// release promoted after a 3-day soak); "edge" is the newest release, pre-releases included.
// AI Office writes the person's choice to `<install root>\channel`, next to the `bin` folder.
export type OpencodealtReleaseChannel = "stable" | "edge"

export function readOpencodealtChannel(
  execPath = process.execPath,
  env: Record<string, string | undefined> = process.env,
): OpencodealtReleaseChannel {
  // OPENCODEALT_RELEASE_CHANNEL=edge|stable overrides the file for one shell.
  const override = env["OPENCODEALT_RELEASE_CHANNEL"]?.trim()
  if (override === "edge" || override === "stable") return override
  try {
    const value = readFileSync(path.join(path.dirname(path.dirname(execPath)), "channel"), "utf8").trim()
    return value === "edge" ? "edge" : "stable"
  } catch {
    return "stable"
  }
}

/** Highest opencodealt version among published (non-draft) releases, pre-releases included. */
export function newestOpencodealtVersion(releases: readonly { tag_name: string; draft?: boolean }[]) {
  return releases
    .filter((release) => !release.draft && release.tag_name.startsWith(OPENCODEALT_TAG_PREFIX))
    .map((release) => opencodealtVersion(release.tag_name))
    .filter((version) => semver.valid(version))
    .sort(semver.rcompare)[0]
}

/** Only a strictly newer release is an update, so an edge build is never offered an older stable. */
export function isNewerOpencodealt(candidate: string, current: string) {
  return !!semver.valid(candidate) && !!semver.valid(current) && semver.gt(candidate, current)
}
