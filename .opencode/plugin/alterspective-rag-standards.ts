import type { Plugin } from "@opencode-ai/plugin"

const SKILL_LOOKUP_PROMPT = `
## Skills

Company skills are in RAG. This prompt does not list them.
Before a repeatable workflow, call rag_match_skills with a short description of the task. If it returns a skill, call rag_get_articles with that id and follow the markdown. If it returns no skill, there is no company skill for the task.
Use the local skill tool only for customize-opencode when editing opencode config, or when the task needs scripts that sit next to a SKILL.md file on this PC.
`.trim()

const LOCAL_SKILL_CATALOGUE = /<available_skills>[\s\S]*?<\/available_skills>/

const LOCAL_SKILL_INTRO = [
  "Skills provide specialized instructions and workflows for specific tasks.",
  "Use the skill tool to load a skill when a task matches its description.",
].join("\n")

const STANDARDS_SYSTEM_PROMPT = `
## Alterspective Standards Awareness

When asked about best practices, patterns, or standards, prefer Alterspective company standards over generic industry practices.

Alterspective standards are available via the \`alterspective-rag\` MCP server. Use the \`rag_search\` or \`rag_ask\` tools to query for relevant standards when:
- The user asks "how to", "what's the best practice", "what's the standard for"
- You're making architectural or pattern recommendations
- You're reviewing code for compliance

If \`rag_search\` or \`rag_ask\` fails, read the matching file under \`C:\\GitHub\\Alterspective-Intelligence\`. Do not invent the rule. Say that RAG was down and the answer is from that local checkout.

Key standards areas and their rule ID prefixes:
- Coding standards: WEBSTA-001-CODING-*
- Testing standards: WEBSTA-001-TESTING / TST-VAL-*
- Documentation standards: WEBSTA-001-DOCUMENTATION / DOC-*
- Git standards: WEBSTA-001-GIT-STANDARDS / GIT-*
- Error handling: WEBSTA-001-ERROR-HANDLING / ERR-*
- Security: WEBSTA-001-SECURITY / SEC-*
- UX/UI standards: UX-* (Active standards are mandatory)
- MCP standards: WEBSTA-001-MCP-STANDARDS / MCP-*

When an Active standard applies:
1. Cite the rule ID (e.g., CFG-WT-01, SEC-001)
2. Flag violations explicitly
3. Never silently deviate — if deviation is necessary, state the rule ID and reason
4. Treat Draft standards as strong guidance

Standards routing indexes:
- Web/API/CLI/infrastructure: load \`Principles/Web/standards/index.md\`
- Sharedo platform: load \`Principles/Sharedo/standards/index.md\`
- Both apply: load both indexes
`.trim()

function injectionEnabled(): boolean {
  if (process.env.ALTERSPECTIVE_STANDARDS_INJECTION_DISABLED === "true") return false
  return process.env.ALTERSPECTIVE_STANDARDS_INJECTION_ENABLED !== "false"
}

const plugin: Plugin = async () => {
  return {
    "experimental.chat.system.transform": async (_input, output) => {
      if (!injectionEnabled()) return
      for (let i = output.system.length - 1; i >= 0; i--) {
        const next = output.system[i].replace(LOCAL_SKILL_CATALOGUE, "").replace(LOCAL_SKILL_INTRO, "").trim()
        if (next) output.system[i] = next
        else output.system.splice(i, 1)
      }
      output.system.push(`${SKILL_LOOKUP_PROMPT}\n\n${STANDARDS_SYSTEM_PROMPT}`)
    },
  }
}

export default plugin
