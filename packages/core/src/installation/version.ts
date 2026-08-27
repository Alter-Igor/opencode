declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
}

export const InstallationBuildTime = "2026-08-27 15:05 AEST"
export const InstallationVersion =
  typeof OPENCODE_VERSION === "string" && OPENCODE_VERSION !== "local"
    ? `${OPENCODE_VERSION} (${InstallationBuildTime})`
    : `1.18.23-alt [${InstallationBuildTime}]`
export const InstallationChannel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "alterspective"
export const InstallationLocal = InstallationChannel === "local"
