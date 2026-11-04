// Cwd-agnostic entry for machine-local launchers (e.g. opencodealt.bat).
// Forwards to packages/cli/src/index.ts after the packages/opencode -> packages/cli split.
import "@opentui/solid/preload"

await import("../../cli/src/index.ts")
