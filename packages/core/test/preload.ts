import fs from "node:fs"
import os from "node:os"
import path from "node:path"

process.env.OPENCODE_DB = ":memory:"
process.env.NPM_CONFIG_AUDIT = "false"
if (!process.env.OPENCODE_TEST_HOME) {
  process.env.OPENCODE_TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-test-home-"))
}
