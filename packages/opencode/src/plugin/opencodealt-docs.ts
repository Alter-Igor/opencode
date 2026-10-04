import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { OPENCODEALT_DOCS_URL } from "@/installation/opencodealt"

// Fork-only (#90): opencodealt is not upstream OpenCode. Upstream's prompts send "how do I"
// questions to opencode.ai/docs, which knows nothing about the features this fork adds.
// `/docs` links the person to our guide and answers from our knowledge base; the system line
// tells the model the same thing when the person asks without the command.

export const DOCS_COMMAND = "docs"

export const DOCS_SYSTEM_LINE =
  "You are running opencodealt, Alterspective's fork of OpenCode. https://opencode.ai/docs covers upstream OpenCode only. " +
  `For opencodealt features (/goal, CAS bridge, opencode-delegate, Synapse models, /docs) use the opencodealt user guide at ${OPENCODEALT_DOCS_URL} ` +
  'and the alterspective-rag tools when they are available (search "opencodealt").'

export const DOCS_TEMPLATE = [
  "The person ran /docs in opencodealt, Alterspective's fork of OpenCode.",
  `Start your reply with the opencodealt user guide link: ${OPENCODEALT_DOCS_URL}`,
  "Their question, if any, follows between the markers.",
  "---",
  "$ARGUMENTS",
  "---",
  "If there is a question, answer it in a few short sentences.",
  'Look up opencodealt features with the alterspective-rag tools when they are available (search "opencodealt").',
  "Use https://opencode.ai/docs only for upstream OpenCode features, and say which source you used.",
  "If there is no question, list the guide's main topics in a few short lines: install and update through AI Office, Synapse models, /goal, CAS bridge, opencode-delegate.",
].join("\n")

export async function OpencodealtDocsPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    config: async (cfg) => {
      // A person's own /docs command wins.
      if (cfg.command?.[DOCS_COMMAND]) return
      cfg.command = {
        ...cfg.command,
        [DOCS_COMMAND]: {
          description: "opencodealt user guide link, or ask a question about opencodealt",
          template: DOCS_TEMPLATE,
        },
      }
    },
    "experimental.chat.system.transform": async (input, output) => {
      // Session turns only; agent generation (no session) keeps its own prompt.
      if (!input.sessionID) return
      output.system.push(DOCS_SYSTEM_LINE)
    },
  }
}
