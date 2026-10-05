- To regenerate the legacy JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- After changing the public Protocol or Server `HttpApi`, run `bun run generate` from `packages/client`. Do not edit `src/generated` or `src/generated-effect` directly.
- Keep runtime dependencies directed from Schema to Core and Protocol, then from Core and Protocol to Server. Client runtime code may depend on Schema and Protocol but never Core or Server; `sdk-next` composes Client, Core, and Server.
- The default branch in this repo is `dev`.
- Local `main` ref may not exist; use `dev` or `origin/dev` for diffs.

## Branch Names

Use a short branch name of at most three words, separated by hyphens. Do not use slashes or type prefixes such as `feat/` or `fix/`.

Examples: `session-recovery`, `fix-scroll-state`, `regenerate-sdk`.

## Commits and PR Titles

Use conventional commit-style messages and PR titles: `type(scope): summary`.

Valid types are `feat`, `fix`, `docs`, `chore`, `refactor`, and `test`. Scopes are optional; use the affected package or area when helpful, e.g. `core`, `opencode`, `tui`, `app`, `desktop`, `sdk`, or `plugin`.

Examples: `fix(tui): simplify thinking toggle styling`, `docs: update contributing guide`, `chore(sdk): regenerate types`.

## Style Guide

### General Principles

- Keep things in one function unless composable or reusable
- Do not extract single-use helpers preemptively. Inline the logic at the call site unless the helper is reused, hides a genuinely complex boundary, or has a clear independent name that improves the caller.
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream
- In `src/config`, follow the existing self-export pattern at the top of the file (for example `export * as ConfigAgent from "./agent"`) when adding a new config module.
- In Effect generators, bind services to named variables before calling methods. Do not use nested service yields such as `yield* (yield* Foo.Service).bar()`.

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Imports

- Never alias imports. Do not use `import { foo as bar } from "..."` or renamed imports like `resolve as pathResolve`.
- Never use star imports. Do not use `import * as Foo from "..."` or `import type * as Foo from "..."`.
- If a namespace-style value is needed, import the module's own exported namespace by name, for example `import { Project } from "@opencode-ai/core/project"`, then reference `Project.ID`.
- Prefer dynamic imports for heavy modules that are only needed in selected code paths, especially in startup-sensitive entrypoints. Destructure dynamic import bindings near the top of the narrowest scope that needs them so they read like normal imports. Avoid inline chains such as `await import("./module").then((mod) => mod.value())` or `(await import("./module")).value()`. Keep branch-specific imports inside the branch that needs them to preserve lazy loading.

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

Avoid `else` statements. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Complex Logic

When a function has several validation branches or supporting details, make the main function read as the happy path and move supporting details into small helpers below it.

```ts
// Good
export function loadThing(input: unknown) {
  const config = requireConfig(input)
  const metadata = readMetadata(input)
  return createThing({ config, metadata })
}

function requireConfig(input: unknown) {
  ...
}
```

- Keep helpers close to the code they support, below the main export when that improves readability.
- Do not over-abstract simple expressions into many single-use helpers; extract only when it names a real concept like `requireConfig` or `readMetadata`.
- Do not return `Effect` from helpers unless they actually perform effectful work. Synchronous parsing, validation, and option building should stay synchronous.
- Prefer Effect schema helpers such as `Schema.UnknownFromJsonString` and `Schema.decodeUnknownOption` over manual `JSON.parse` wrapped in `Effect.try` when parsing untrusted JSON strings.
- Add comments for non-obvious constraints and surprising behavior, not for obvious assignments or control flow.

### Schema Definitions (Drizzle)

Use snake_case for field names so column names don't need to be redefined as strings.

```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})

// Bad
const table = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

## Testing

- Avoid mocks as much as possible, you shouldn't be using globalThis.\* at all unless it's the only option.
- Test actual implementation, do not duplicate logic into tests
- Tests cannot run from repo root (guard: `do-not-run-tests-from-root`); run from package dirs like `packages/opencode`.

## Type Checking

- Always run `bun typecheck` from package directories (e.g., `packages/opencode`), never `tsc` directly.

## V2 Session Core

- Keep durable prompt admission separate from model execution. `SessionV2.prompt(...)` admits one durable `session_input` row before scheduling advisory `SessionExecution.wake(sessionID)` unless `resume: false` requests admit-only behavior. The serialized runner promotes admitted inputs into visible user messages at safe boundaries.
- Reusing a Session ID adopts the existing Session. Reusing a prompt message ID reconciles an exact retry only when Session, prompt, and delivery mode match; conflicting reuse fails. Historical projected prompts lazily synthesize promoted inbox records during exact retry.
- Keep `SessionExecution` process-global and Session-ID based. Its local implementation owns the process-local Session coordinator and discovers placement through `SessionStore` plus `LocationServiceMap.get(session.location)` only when a drain starts; no layer should take a Session ID. V2 interruption targets the active process-local ownership chain for that Session; idle or missing interruption is a no-op.
- Keep `SessionRunner`, model resolution, tool registry, permissions, and filesystem Location-scoped. Omitted `Location.workspaceID` means implicit-local placement; explicit workspace identity remains reserved for future placement semantics.
- Preserve one explicit `llm.stream(request)` call per provider turn and reload projected history before durable continuation. Do not bridge through legacy `SessionPrompt.loop(...)` or delegate orchestration to an in-memory tool loop.
- Keep local Session drains process-local until clustering is implemented. `SessionRunCoordinator` joins explicit same-Session resumes, coalesces prompt wakeups, and allows different Sessions to run concurrently. Advisory wakes drain eligible durable inbox rows only; post-crash continuation recovery requires a separate explicit design before it may retry provider work. A drain has no durable identity or transcript boundary.
- Keep delivery vocabulary explicit. Prompts steer by default and promote at the next safe provider-turn boundary while the current drain requires continuation. An explicit `queue` input remains pending until the Session would otherwise become idle; promote one queued input at that boundary, then reevaluate continuation before promoting another. Promoting any new user input resets the selected agent's provider-turn allowance; a batch of steers resets it once.
- Keep EventV2 replay owner claims separate from clustered Session execution ownership.
- Keep the System Context algebra, registry, and built-ins in `src/system-context`; keep Context Source producers with their observed domains, and keep Session History selection plus Context Epoch persistence Session-owned.

## Fork-local (Alterspective) notes

This repo is the Alterspective fork (`origin` = `Alter-Igor/opencode`, `upstream` = `anomalyco/opencode`). We work fork-locally: no upstream PRs; keep every local change small and in low-churn files so `git fetch upstream && git merge upstream/dev` stays clean. After any upstream sync: `bun install`, `bun typecheck` from package dirs, `bun test` from `packages/core` and `packages/opencode` (some tests fail on Windows pre-existing — compare against the pre-merge baseline before blaming the sync).

- **Our patches**: `packages/opencode/src/provider/vision-proxy.ts` (vision proxy middleware for text-only models), wired via `wrapLanguageModel` middleware in `packages/opencode/src/session/llm.ts`. Regression test: `packages/opencode/test/provider/vision-proxy.test.ts` — run it after every upstream sync.
- **Alterspective integration** (`.opencode/` only — zero `src/` changes, upstream can't conflict): plugins `plugin/synapse-coder-reporter.ts` (LSP-diagnostics paired-correction reporter to Synapse Coder staging; env-gated `SYNAPSE_CODER_REPORTER_ENABLED`, offline queue `.opencode/synapse-coder-queue.json`, first-use TUI toast) and `plugin/alterspective-rag-standards.ts` (standards system-prompt injection via `experimental.chat.system.transform`); `scripts/health-check.ts` (health/version sidecar, default port 4043 — 4040-4042 are owned by Docker Desktop's backend on Windows); `opencode.jsonc` wires Alterspective MCPs (synapse-coder via canonical host `staging.synapse-coder-mcp.alterspective.com.au`, alterspective-rag, keystone, timely, sharedo, vault-local, azure-devops — local entries need `command: string[]` + `environment` + `enabled`, not `args`/`env`). Tests: `packages/opencode/test/plugin/synapse-coder-reporter/` and `test/plugin/alterspective-rag-standards/` — run after upstream syncs. Plan + evidence: `docs/implementation/current/SYN-001-synapse-coder-reporter/` (merged PRs #1, #2).
- **Alterspective branding** (TUI): `packages/tui/src/theme/assets/alterspective.json` (brand palette theme, registered in `theme/index.ts`), fork default theme set to `alterspective` in `packages/tui/src/context/theme.tsx`, ALTERSPECTIVE ASCII wordmark in `packages/tui/src/logo.ts` (shared by `util/presentation.ts` epilogue via import), home splash left-aligned per brand rule LOGO-001 in `packages/tui/src/routes/home.tsx`. After upstream syncs touching these files, re-verify the wordmark renders (bun -e render check) and the theme still registers.
- **Local launcher (`opencodealt`)**: machine-local Nodist shim `opencodealt.bat` runs `bun run --conditions=browser` against `packages/opencode/src/index.alterspective.ts` (absolute path to this clone) so the fork starts from any cwd. That entry registers `@opentui/solid/preload` then loads `index.ts` — required because bun only applies `bunfig.toml` preloads from the process cwd. Do not delete the entry without updating the bat.
- **opencodealt release** (#90): `.github/workflows/opencodealt-release.yml` (manual `workflow_dispatch`, Windows runner) builds `opencodealt.exe` with `OPENCODE_CHANNEL=opencodealt` and `OPENCODE_VERSION=<package version>-alt.<run number>`, then publishes release `opencodealt-v<version>` with `opencodealt-windows-x64.zip` + `.sha256`. AI Office (`aio opencode install`, tool-ai-office#499) installs from it. On that channel `Installation.method()` returns `"aio"` before any package-manager probe (`src/installation/opencodealt.ts`): updates are checked against this repo's releases, auto-update only notifies, and "Update now" / `opencodealt upgrade` runs `aio opencode install`. Never let an opencodealt build fall through to upstream `opencode-ai`. **Channels (#97):** every code merge to `dev` publishes an EDGE pre-release; `opencodealt-promote.yml` (daily, script `.github/scripts/opencodealt-promote.sh`) marks the newest edge as stable (GitHub Latest) after a 3-day soak with no newer edge and no open `release-hold` issue; manual run with a tag promotes or rolls back. A build reads its channel from `<install root>\channel` (written by AI Office) or `OPENCODEALT_RELEASE_CHANNEL`; edge checks all releases, stable checks Latest; it only ever offers a strictly newer version. **`/docs`** (`src/plugin/opencodealt-docs.ts`, internal plugin): links the AI Office guide `https://aio.alterspective.com.au/app/ai-os/opencodealt` and answers from the knowledge base; it also adds one system line saying `opencode.ai/docs` is upstream only. The release binary does NOT include this repo's `.opencode/` folder (CAS bridge, project MCPs). Tests: `test/installation/installation.test.ts`, `test/plugin/opencodealt-docs.test.ts`. Pack: `docs/implementation/current/FEAT-OPENCODEALT-RELEASE/`.
- **CAS bridge** (`.opencode/`): MCP `alterspective-agent` → `https://agent.alterspective.com.au/api/v1/mcp` with **OAuth** (`opencode mcp auth alterspective-agent`, scope `cas.access`, loopback :19876). Tokens from OpenCode `mcp-auth.json` (or optional `CAS_MCP_TOKEN`). Tools: `cas-auth-status`, `cas-select-agent`, `cas-safe-*` (delegate/list/get/cancel + **list-runs / run-insights / run-trace**), `cas-pipeline-status`, **`synapse-probe`** (live `x-synapse-served-model` + rate limits; needs `SYNAPSE_API_KEY`/`GPAAS_API_KEY`). Slash: `/cas`, `/cas-insights`. Façades `cas-delegate` / `cas-drafter` / `cas-matter-audit`. In-repo pack: `docs/implementation/current/FEAT-CAS-OPENCODE-BRIDGE/` (start at `INDEX.md`). **AIO (what we are doing with OpenCode):** `Reference/AI/Capabilities/KB-AI-036-OpenCode-Alterspective-Fork-And-CAS-Bridge.md` in Alterspective-Intelligence. Tests: `packages/opencode/test/plugin/cas-bridge/`.
- **Windows env**: `turbo.json` `globalPassThroughEnv` includes `NODIST_PREFIX`/`NODIST_X64` — required so the Nodist node shim works under turbo's strict env-mode (the pre-push hook's 30-package typecheck fails without it). Do not remove.
- **Delegate MCP bridge** (`alterspective/delegate-mcp/`, FEAT-OCD-001, #41): local stdio MCP server that lets other AIs drive OpenCode sessions running in a Docker box whose only network exit is an allowlist (Keystone MCP + Synapse + npm + PyPI). **BFA-003 exclusion (approved by the owner, 2026-10-01):** category = local developer tool; condition = stdio only, no remote access, never exposed beyond `127.0.0.1`; approver = owner. A hosted version must add Streamable HTTP + Keystone OAuth first. Plan pack: `docs/implementation/current/FEAT-OCD-001-opencode-delegate-mcp/`. **Full delegation** (#104, owner decision 2026-10-04, replaces R4-01's "never `/mcp/dynamic`" for boxes that choose it): the reserved connection id `dynamic` (`ks-dynamic` → Keystone `/mcp/dynamic`) reaches Keystone only through the `mcp-gate` container (`alterspective/delegate-mcp/mcp-gate/`), which applies the owner's delegation profile (`OPENCODE_DELEGATE_DYNAMIC_PROFILE`, CAS field names, narrow-only) and makes risky tools wait for an approval (`oc_pending` / `oc_answer`, kind `approval`). Needs host-held tokens; the box is not on the gate's network. Policy and risk words are copied from CAS, not shared. **Fork patch** (env-gated, no effect unless `OPENCODE_MCP_ALLOW` is set): `packages/opencode/src/mcp/allowlist.ts` (new) + small hooks in `mcp/index.ts` (`create`, `startAuth`, transport `fetch`) and `mcp/oauth-provider.ts` (`refreshSingleFlightFetch`: one refresh-token grant per token in flight, so Keystone never sees a reused refresh token). After every upstream sync run `bun test test/mcp/allowlist.test.ts test/mcp/allowlist-lifecycle.test.ts test/mcp/refresh-single-flight.test.ts` from `packages/opencode`. Known gap: `opencode mcp debug` (`cli/cmd/mcp.ts`) builds its own transport without either hook. **Synapse model list** (#74, fork-only `packages/opencode/src/plugin/synapse.ts` + `synapse-models.ts`): the `synapse` provider loads Synapse `GET /v1/models` at startup, always adds `auto`, never renews a sign-in at startup (expired token: cached `synapse-models.json` in the state folder, else the configured list), and keeps every replaced refresh token so one process never reuses one. Across processes (a TUI plus `opencode serve`, or two TUIs) the refresh grant runs under a machine-wide `Flock` lock keyed on `auth.json` (#75); after taking it the plugin re-reads the stored credential and uses a token another process just rotated instead of spending its own, and the rotated token is saved before the lock is released. A Keystone refresh call gives up after 30 s; a lock wait after 60 s (the chat then keeps its token). Models Synapse marks `capabilities.tools: false` are left out (#80). **Pinned-model fallback** (#80, `synapse-fallback.ts`): a pinned `synapse/<id>` that fails with credit/budget, no tool support, not found/unavailable or rate limit is resent once with `auto` (same body and headers, so `x-privacy-tier: local-only` stays local-only; never for 401/403 or context/validation errors), logged as `FALLBACK_TRIGGERED` (model, reason, status, served model; no token, no text) and shown as a TUI toast, once per session and model. A failed pinned model is then skipped (straight to `auto`) for that session for about 10 minutes (process memory only). The MCP bridge path uses the same classifier. Not in the delegate box: the box does not load this plugin, so Synapse-side failover (Synapse #850 / #1813) handles a failed model. With `stream: true` Synapse sends HTTP 200 and puts the failure in the first SSE event, so the plugin peeks at that first event only (at most 64 KB / 15 s, then the stream is handed on byte for byte) and falls back the same way. Tests write diagnostics under `OPENCODE_TEST_HOME` (or `OPENCODE_DIAGNOSTICS_DIR`), never the real `~/.local/share/opencode/log`. Set `OPENCODE_SYNAPSE_PINNED_FALLBACK=0` to turn it off. **Forced privacy tier** (#101): when `SYNAPSE_PRIVACY_TIER` is set (the sandbox supervisor sets it), every Synapse call the plugin makes carries `local-only`: the REST chat path (set last, so no request or provider header can remove or widen it), the MCP bridge chat path, `synapse_buddy_review` and the model list (the config hook puts it on the `synapse` provider headers). Any non-empty value means `local-only`, so a typo narrows routing and never widens it. After every upstream sync run `bun test test/plugin/synapse-models.test.ts test/plugin/synapse-models-provider.test.ts test/plugin/synapse-fallback.test.ts test/plugin/synapse-privacy-tier.test.ts` from `packages/opencode`.
- **Fast-cycle delivery** (#93, KB playbook `Practice/AI/playbooks/AIPB-008-Fast-Cycle-Delivery-And-Pipeline-Acceleration.md`): do not run the full `packages/opencode` suite locally to check a change. On this Windows box it takes 10+ minutes and fails in many places unrelated to any change. Use the tiers instead. **Tier 1 (seconds):** `bun run test:fast` from the repo root (`script/test-fast.ts`) runs oxlint on the changed files and only the tests mapped to them (same-name tests beside the changed source, the flat `test/<dir>-*.test.ts` layout, and every test that imports the changed module directly); `--list` shows the plan, `--base <ref>` changes the comparison (default `origin/dev`). `bun test --changed` is not used: plugin and core files reach most of the suite through imports. **Tier 1 in CI:** the `fast` job of `.github/workflows/alterspective-fast-cycle.yml` runs the same on every PR, plus the opencode typecheck. **Tier 2:** its `full` job runs the whole `packages/opencode` suite on GitHub-hosted Linux for every PR and every push to `dev`; `integrate` reads that job on the PR head instead of a local full run. #112: the suite runs as 4 parallel `full shard N/4` jobs (`bun test --shard`, split by file), and `full` passes only when every shard passed; a failure names its shard. No `--parallel` inside a shard, for the CLI child cap below. #95 fixed the 13 Linux failures `dev` had when `full` first ran, so `full` should be green: treat any failure as new unless the PR shows it also fails on `dev`. #100: `test.concurrent` CLI subprocess tests used to start about ten cold `bun run src/index.ts` children at once, and on the 4-vCPU runner each took 13-15 s instead of about 2 s; `test/lib/cli-process.ts` now runs at most `OPENCODE_TEST_CLI_CONCURRENCY` short-lived CLI children at once (default half the CPUs, minimum 2). Upstream tests that must not see the fork's own built-in plugins (Synapse, /goal, /docs) set `RuntimeFlags.layer({ disableForkPlugins: true })` or `OPENCODE_DISABLE_FORK_PLUGINS=true`. No merge queue: it needs an organisation-owned repository and this fork is user-owned.
- **Symlinks**: Windows has no symlink privilege here, so repo symlinks check out as text placeholders. The two typecheck-blocking ones (`packages/app/src/custom-elements.d.ts`, `packages/enterprise/src/custom-elements.d.ts`) are replaced with local hardlinks hidden via `git update-index --skip-worktree` (list them: `git ls-files -v | Select-String '^S'`). ~60 asset symlinks (favicons etc.) remain placeholders — harmless for typecheck/TUI, but app/web builds serving those assets need Developer Mode enabled first.
- The remediation plan and full revalidation evidence live in `specs/arch-remediation-plan.md`.
