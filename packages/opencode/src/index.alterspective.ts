// Cwd-agnostic entry for machine-local launchers (e.g. opencodealt.bat).
// Bun only applies bunfig.toml preloads from the process cwd, so register the
// Solid JSX transform before loading the real CLI when the caller is elsewhere.
import "@opentui/solid/preload"

await import("./index.ts")
