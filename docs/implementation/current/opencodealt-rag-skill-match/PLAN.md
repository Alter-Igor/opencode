# RAG skill match (option 2)

Status: logged for the RAG team as [Alterspective-Engine/alterspective-rag-service#642](https://github.com/Alterspective-Engine/alterspective-rag-service/issues/642). Option 1 is the live prompt change in `.opencode/plugin/alterspective-rag-standards.ts`.

## What is already on

- `rag_search` finds knowledge-base pages by meaning, including files under `Skills/`.
- `rag_list_skills` returns the whole `Skills/` catalogue from the git tree. It is complete. It is not an embedding search.
- `rag_get_articles` returns the full markdown for one path.

## What is not on

`KB-AI-020` describes skill discovery. The code is deployed. The production switch `ANALYTICS_SKILL_INSIGHTS` is not set, so the weekly admin report writes nothing. Turning that switch on does not give the agent a match tool. It only starts the report.

## Option 2

Add one RAG tool, then point the OpenCode prompt at it.

- Name: `rag_match_skills`.
- Input: the task the agent is about to do, as a short string.
- Output: at most three skills. Each row is the skill id (repo path), the title, and one line of description.
- Match only skill descriptions, not the whole knowledge base.
- The agent then calls `rag_get_articles` with the chosen path.
- Do not call `rag_list_skills` for this. That returns the full catalogue and puts a large list back into the turn.

After the tool exists, change the Skills paragraph in `.opencode/plugin/alterspective-rag-standards.ts` so it says call `rag_match_skills` instead of `rag_search`.

Owner: the RAG service first, then one paragraph in this fork. No Synapse change. No CAS change.
