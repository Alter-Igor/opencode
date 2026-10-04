import { InstallationChannel } from "@opencode-ai/core/installation/version"

// Fork-only (#90): opencodealt release builds (`OPENCODE_CHANNEL=opencodealt`) come from this
// repo's GitHub releases and are installed by AI Office (`aio opencode install`). They must
// never check, or install, upstream `opencode-ai`.

export const OPENCODEALT_CHANNEL = "opencodealt"
export const OPENCODEALT_REPO = "Alter-Igor/opencode"
export const OPENCODEALT_TAG_PREFIX = "opencodealt-v"
export const OPENCODEALT_LATEST_RELEASE_URL = `https://api.github.com/repos/${OPENCODEALT_REPO}/releases/latest`
export const OPENCODEALT_DOCS_URL = "https://aio.alterspective.com.au/app/ai-os/opencodealt"
export const OPENCODEALT_UPDATE_COMMAND = ["aio", "opencode", "install"]

export function isOpencodealt(channel = InstallationChannel) {
  return channel === OPENCODEALT_CHANNEL
}

/** `opencodealt-v1.18.31-alt.7` → `1.18.31-alt.7` */
export function opencodealtVersion(tag: string) {
  return tag.startsWith(OPENCODEALT_TAG_PREFIX) ? tag.slice(OPENCODEALT_TAG_PREFIX.length) : tag.replace(/^v/, "")
}
