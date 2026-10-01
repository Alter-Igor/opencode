# FEAT-OCD-001 — Requirements

Source: owner requests in the session of 2026-09-30, and issue #41.

## Functional

| ID | Requirement | Source |
|---|---|---|
| R1 | Start an OpenCode session in a chosen repo folder | Owner: "tell it which repo to run in" |
| R2 | Send a task and choose the model and agent per task | Owner: "tell it what to do, what model to use" |
| R3 | Check a session's status at any time | Owner: "check up on its status" |
| R4 | Be told about events: status changes, completion, needs-input, errors | Owner: "listen for event such as status updates completion" |
| R5 | Agents can message each other (Claude ↔ OpenCode, OpenCode ↔ OpenCode) | Owner: "have the agents communicate with each other" |
| R6 | Run many sessions at the same time | Owner: "run multiple sessions" |
| R7 | Delegated sessions may use **only** Keystone MCP services (`/mcp/dynamic`, `/mcp/c/<id>`) | Owner: "it should only be able to use the keystone mcp services" |
| R8 | MCP access uses OAuth as the signed-in person; no shared keys | Owner: "it should use oauth based on the user"; BFA-007 |
| R9 | Local only for now | Owner: "run it locally" |

## Non-functional / implicit

| ID | Requirement |
|---|---|
| I1 | Fail closed: if the Keystone-only rule cannot be proven, refuse to run the task |
| I2 | No secret values in logs, tool results, or anything the agent's shell can read |
| I3 | Two sessions do not silently edit the same folder |
| I4 | The owner can watch delegated sessions in the OpenCode web UI |
| I5 | Survive a server restart and a dropped event stream without false "done" claims |
| I6 | No edits to upstream-owned files; upstream merges stay clean (`AGENTS.md:165`) |

## Out of scope (this feature)

- A hosted/remote bridge behind Keystone (later feature; would need BFA-003 HTTP transport).
- Network sandboxing of agent shells (see risk 3 and question Q2).
- Changing Keystone itself.
