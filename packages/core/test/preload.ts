import fs from "node:fs"
import os from "node:os"
import path from "node:path"

process.env.OPENCODE_DB = ":memory:"
process.env.NPM_CONFIG_AUDIT = "false"
if (!process.env.OPENCODE_TEST_HOME) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-test-home-"))
  const temporary = path.join(home, "tmp")
  fs.mkdirSync(temporary, { recursive: true })
  process.env.HOME = home
  process.env.OPENCODE_TEST_HOME = home
  process.env.XDG_CONFIG_HOME = path.join(home, ".config")
  process.env.XDG_DATA_HOME = path.join(home, ".local", "share")
  process.env.XDG_CACHE_HOME = path.join(home, ".cache")
  process.env.XDG_STATE_HOME = path.join(home, ".local", "state")
  process.env.OPENCODE_CONFIG_DIR = path.join(home, ".config", "opencode")
  delete process.env.OPENCODE_CONFIG
  delete process.env.OPENCODE_CONFIG_CONTENT
  process.env.TMPDIR = temporary
  if (process.platform === "win32") {
    process.env.USERPROFILE = home
    process.env.TMP = temporary
    process.env.TEMP = temporary
  }
}
