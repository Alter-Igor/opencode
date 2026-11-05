// Cwd-agnostic entry for machine-local launchers (e.g. opencodealt.bat).
// Forwards to packages/cli/src/index.alterspective.ts after the packages/opencode -> packages/cli split.
await import("../../cli/src/index.alterspective.ts")
