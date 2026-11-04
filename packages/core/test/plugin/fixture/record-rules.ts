// #217: a separate OpenCode process writing rules, for the cross-process lock test in observer.test.ts.
// Usage: bun record-rules.ts <prefix> <count> <workspaceDir>, with OPENCODE_TEST_HOME set by the test.
import { sessionObserver } from "../../../src/plugin/observer"

const [prefix, count, workspaceDir] = process.argv.slice(2)
for (let i = 0; i < Number(count); i++) {
  const saved = await sessionObserver.recordLearning({ lesson: `${prefix} rule ${i}`, source: "user_feedback" }, workspaceDir)
  if (saved.savedTo.length !== 2) throw new Error(`${prefix} rule ${i} saved to ${saved.savedTo.join(",") || "nothing"}`)
}
