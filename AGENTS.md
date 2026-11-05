- After changing the public Protocol or Server `HttpApi`, run `bun run generate` from `packages/client`. Do not edit generated client files directly.
- Keep runtime dependencies directed from Schema to Core and Protocol, then from Core and Protocol to Server. Client runtime code may depend on Schema and Protocol but never Core or Server; `sdk` composes Client, Core, and Server.
- This repository does not use Changesets. Do not add `.changeset` files; follow the existing release workflow instead.
- The default branch is `dev`. Base branches and worktrees on `origin/dev`, target PRs at `dev`, and diff against `origin/dev` unless told otherwise.

## Live TUI Testing

- Run `bun run dev:live` from a development worktree to test its TUI against the currently elected `opencode` background server and live sessions.
- Pass a directory after the script when needed, for example `bun run dev:live /path/to/project`.
- The script discovers the server with `opencode service status`, injects its private local credential from `opencode service get password`, and uses the `dev` TUI storage channel so tabs and other client-local state match the installed client.
- Prefer `dev:live` over plain `bun run dev` for this workflow. An implicit managed-service connection may replace the live server when the worktree client version differs; explicit `--server` warns and continues without replacing it.

## Live Desktop Diagnostics

- When attaching Playwright to a running desktop app, use `chromium.connectOverCDP(endpoint, { noDefaults: true })`.
- Without `noDefaults`, Playwright applies light-mode media emulation during attachment. An app following the system theme then flashes light until the connection closes. The option also preserves the existing focus and other media preferences.
- Do not emulate a color scheme or reduced-motion preference on the user's live window unless explicitly requested; use an isolated test context for those scenarios.

## TUI Stories

- When a user asks for a TUI story, add a fixture-driven story under `packages/tui/src/feature-plugins/system/storybook` and register it in `index.tsx`.
- Render the real production component rather than a visual copy. Keep submissions and other side effects local to the story so it is safe to explore repeatedly.
- Expose the meaningful state dimensions through story keybindings and list them in `StoryFooter`; include a reset command when combinations can leave the fixture in a confusing state.
- Run a specific story with `OPENCODE_STORY=<story-id> bun run dev:live` from the development worktree, and exercise narrow and wide terminal sizes when layout is relevant.

## TUI Theme Tokens

- Choose theme tokens by semantic role, not by their current color. Do not use raw `theme.hue` values or borrow an unrelated semantic token to achieve a preferred appearance.
- Use `text.feedback` and `background.feedback` only for outcome or status feedback such as errors, warnings, success messages, and informational messages. Use `formfield` states for form-control text, ordinals, and selection markers, and `action` states for actions.
- If the theme does not expose a token for the required semantic role, extend the theme schema, defaults, resolution, and types with that role before using it in a component. Do not repurpose the nearest-looking existing token.
- When changing the public theme token surface, verify the built-in light and dark defaults and the custom-theme fallback path in addition to the affected TUI component.

## Branch Names

Use a short branch name of at most three words, separated by hyphens. Do not use slashes or type prefixes such as `feat/` or `fix/`.

Examples: `session-recovery`, `fix-scroll-state`, `regenerate-sdk`.

## Commits and PR Titles

Use conventional commit-style messages and PR titles: `type(scope): summary`.

Valid types are `feat`, `fix`, `docs`, `chore`, `refactor`, and `test`. Scopes are optional; use the affected package or area when helpful, e.g. `core`, `opencode`, `tui`, `app`, `desktop`, `sdk`, or `plugin`.

Examples: `fix(tui): simplify thinking toggle styling`, `docs: update contributing guide`, `chore(sdk): regenerate types`.

For user-facing `feat`, `fix` and `perf` PRs, add a small looping animated SVG of the change under `### Visual` in the PR body (a `svg` code block, 240×72, for example a dock growing out of the composer or spinners turning in step). Draw with `currentColor` and opacity so it works in light and dark, make the unanimated state a good still (it is shown under reduced motion), animate with CSS or SMIL only, and keep it under 8 KB with no scripts or external references. The desktop beta's "What's new" dialog shows it.

## Style Guide

### General Principles

- Keep things in one function unless composable or reusable
- Validate unknown values once at the boundary that owns them. Pass typed values inward instead of repeating `typeof value === "object"` and property-existence checks. Do not defensively revalidate values already guaranteed by a schema, constructor, or internal type.
- Do not extract single-use helpers preemptively. Inline the logic at the call site unless the helper is reused, hides a genuinely complex boundary, or has a clear independent name that improves the caller.
- Before adding complexity for a speculative or vanishingly unlikely race or security edge case, explain the concrete failure mode, likelihood, and complexity cost to the user and get their buy-in. Do not silently expand scope for theoretical robustness.
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream
- In `src/config`, follow the existing self-export pattern at the top of the file (for example `export * as ConfigAgent from "./agent.js"`) when adding a new config module.
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
- Never use type-position `import("...")` references such as `Schema.declare<import("@opencode/plugin/effect/plugin").Plugin["effect"]>`. Only when two imports genuinely collide on a name and no other option exists, an aliased type import (`import type { Plugin as PluginDefinition } from "..."`) is permitted as a last resort — still strongly preferred not to.
- Never use star imports. Do not use `import * as Foo from "..."` or `import type * as Foo from "..."`.
- If a namespace-style value is needed, import the module's own exported namespace by name, for example `import { Project } from "@opencode/core/project"`, then reference `Project.ID`.
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

### Experimental API

- An experimental endpoint lives at `/api/experimental/<group>/...`, its OpenAPI identifier is `experimental.<group>.<method>`, and it lands in the SDK as `client.experimental.<group>.<method>`. Its description says "Experimental: may change without compatibility guarantees."
- `packages/protocol/test/experimental-identifiers.test.ts` enforces the path and identifier match in both directions; the SDK namespace follows from the path.
- An experimental field or parameter on a stable endpoint goes under an `experimental` key (`experimental.<name>`), the same way config does (`config.experimental.*`).
- New endpoints and new default behaviors start experimental.
- To graduate one, move the route out of `/api/experimental`, drop the `experimental.` prefix, and note it in `CHANGELOG.md`.
- Experimental HTTP routes change without aliases: rename or remove the route, then update the callers.
- A breaking move of shipped SDK or plugin API (including moving it under `experimental`) keeps the old path and type names as deprecated aliases of the new ones until the next minor, each marked `@deprecated` with the replacement and "Removed in the next minor". Generated SDK moves get them from the codegen (`compile(..., { aliases: true })` in `packages/client/script/generate.ts`), not by hand.
- Experimental plugin hooks are named `experimental.*` (`experimental.ws.handshake`).

## Testing

- Avoid mocks as much as possible, you shouldn't be using globalThis.\* at all unless it's the only option.
- Test actual implementation, do not duplicate logic into tests
- Tests cannot run from repo root (guard: `do-not-run-tests-from-root`); run from package directories such as `packages/core`.
- Before writing or changing tests, read the matching skill in `.opencode/skills`: `unit-tests` (bun test), `tui-tests` (OpenTUI renderer tests), `app-e2e-tests` (Playwright in `packages/app/e2e`) or `component-tests` (Playwright on stories, `packages/stories`). They cover what has made tests slow or flaky in CI.

## Checks

- Run `bun run check` from the repository root as the canonical full lint and type-check verification.
- During focused iteration, run `bun typecheck` from the affected package directory (for example, `packages/core`). Never run `tsc` directly.
- Package `typecheck` and `typecheck:tsc` scripts run the official TypeScript compiler (`tsc -b` / `@typescript/native`). When `bun check` and `tsc` disagree, `tsc` is the source of truth; reproduce with `bun run typecheck` or `bun run typecheck:tsc` from the package directory.
- `bun check` aims to match TypeScript 7.1, not the `7.0.2` that `process.versions.typescript` reports (oven-sh/bun#46536). When `bun check` and `tsc` from the pinned `@typescript/native` report different errors, file a minimal, dependency-free repro at https://github.com/oven-sh/bun/issues, with the output of both. `bun check` writes no declaration files, so declaration-emit errors such as TS5088 or TS2883 are expected to appear only in `tsc`; do not report those.

## Session Core

- Keep durable events minimal: record irreducible new facts and do not repeat state derivable by folding the ordered aggregate history. Enrich projections and read models with previous or derived state when consumers need self-contained views.
- Keep durable prompt admission separate from model execution. `Session.prompt(...)` publishes `session.inbox.enqueued`, whose projection inserts one durable `session_inbox` row, before scheduling advisory `SessionExecution.wake(sessionID)` unless `resume: false` requests admit-only behavior. Delivery publishes `session.inbox.delivered`; its projection consumes the inbox row and inserts the visible message in the same transaction. `session_inbox` stores only unconsumed work.
- Reusing a Session ID adopts the existing Session. Reusing a user or synthetic inbox item ID is idempotent when Session and type match: the first admission wins and the retried payload, metadata, and delivery mode are ignored, whether the item is still pending or already delivered (reconciled from the projected message without retained enqueue history). Cross-Session or cross-type reuse fails. Control items keep their operation-specific conflict behavior.
- Keep `SessionExecution` process-global and Session-ID based. Its local implementation owns the process-local Session coordinator and discovers placement through `SessionStore` plus `LocationServiceMap.get(session.location)` only when a drain starts; no layer should take a Session ID. Interruption targets the active process-local ownership chain for that Session; interruption of a known but idle or locally unowned Session is a no-op, while the public API rejects an unknown Session.
- Keep `SessionRunner`, model resolution, tool registry, permissions, and filesystem Location-scoped. Omitted `Location.workspaceID` means implicit-local placement; explicit workspace identity remains reserved for future placement semantics.
- Each step is one explicit `llm.stream` call that continues from reloaded history. Do not add an in-memory tool loop.
- Keep local Session drains process-local until clustering is implemented. `SessionRunCoordinator` joins explicit same-Session resumes, coalesces prompt wakeups, and allows different Sessions to run concurrently. A write-ahead execution claim marks a process-local busy period for restart recovery: terminal completion, failure, or user interruption releases it, while shutdown interruption and process death preserve it. Startup recovery resumes claimed top-level Sessions with durable per-execution attempt accounting. The claim is a recovery marker, not clustered ownership, fencing, or an exactly-once guarantee.
- Keep delivery vocabulary explicit. Prompts steer by default. At safe step boundaries, steered compaction takes priority up to the first steered move control; other steers retain enqueue order. At an idle boundary, steers take priority; otherwise exactly one queued item delivers before the runner reevaluates continuation. Inbox items may be cancelled or changed between queue and steer before delivery. Promoting new user input resets the selected agent's step allowance; a batch of steers resets it once.
- One step is one logical LLM call; its durable record covers only the model-visible span. Do not write "provider turn", and do not use bare "turn" for a single call: "turn" is reserved for the future assistant-turn unit containing all steps from prompt promotion until the session would go idle.
- Keep event replay ownership separate from clustered Session execution ownership.

## Fork-local (Alterspective) notes

This repo is the Alterspective fork (`origin` = `Alter-Igor/opencode`, `upstream` = `anomalyco/opencode`). We work fork-locally: no upstream PRs; keep every local change small and in low-churn files so `git fetch upstream && git merge upstream/dev` stays clean. After any upstream sync: `bun install`, `bun typecheck` from package dirs, `bun test` from `packages/core` (some tests fail on Windows pre-existing — compare against the pre-merge baseline before blaming the sync).

- **Our patches**: `packages/core/src/provider/vision-proxy.ts` (vision proxy middleware for text-only models), wired in `packages/core/src/session/model-request.ts`. Regression test: `packages/core/test/provider/vision-proxy.test.ts` — run it after every upstream sync. **Synapse vision as eyes** (#193, `packages/core/src/plugin/synapse-vision.ts` + tool `synapse_vision` in `packages/core/src/plugin/synapse.ts`): a text-only model (pinned session or sub-agent) calls `synapse_vision { image, question }` and gets a text answer from Synapse (`model: "auto"`). Credential order matches the `/models` call: the stored sign-in (refreshed when near expiry), else the configured `apiKey`, else none (a front proxy may add it); the forced privacy tier (#101) applies. A file outside the project directory (or outside the worktree, unless it is the non-git `/`) asks `external_directory` with the same pattern as `packages/core/src/file-access.ts` (the `<tmp>/opencode/vision` folder never asks). Unlike `read`, links are resolved first: the real target is checked (against real roots) and asked for, so a link inside the project that points outside it asks, and the file read must be the same file (dev/ino, via a no-follow handle where the OS has one) that was approved (#198); a refused ask or a cancel stops the tool. An http(s) image URL asks `webfetch` first (Synapse fetches it), like the `webfetch` tool (#235). With no `vision_proxy` configured, a `synapse` provider in the config that `disabled_providers` / `enabled_providers` do not turn off, and `synapse_vision` among the request's tools, the proxy saves each image a text-only model would get to `<tmp>/opencode/vision/<first 32 hex of sha256>.<ext>` (folder 0700, files 0600, files older than 7 days swept once per process; SVG, empty or >20 MB images are not saved) and swaps the image for a note naming that path and the tool. The same swap runs for the native runtime (`packages/core/src/session/model-request.ts`) and for images kept inside tool results (`media` / `image-data` / image `file-data` items) for SDKs where `supportsMediaInToolResult` is true (#235). Not swapped: URL or file-id tool-result items (`image-url`, `file-url`, `*-file-id`). Synapse answers 404 when no model with the `vision` op is up; the tool then says so plainly. Test: `packages/core/test/plugin/synapse-vision.test.ts`.
- **Alterspective integration** (`.opencode/` + built-in `packages/core/src/plugin/alterspective-rag-standards.ts`): plugins `plugin/synapse-coder-reporter.ts` (LSP-diagnostics paired-correction reporter to Synapse Coder staging; env-gated `SYNAPSE_CODER_REPORTER_ENABLED`, offline queue `.opencode/synapse-coder-queue.json`, first-use TUI toast) and `plugin/alterspective-rag-standards.ts` (standards system-prompt injection via `experimental.chat.system.transform`); `scripts/health-check.ts` (health/version sidecar, default port 4043 — 4040-4042 are owned by Docker Desktop's backend on Windows); `opencode.jsonc` wires Alterspective MCPs (synapse-coder via canonical host `staging.synapse-coder-mcp.alterspective.com.au`, alterspective-rag, keystone, timely, sharedo, vault-local, azure-devops — local entries need `command: string[]` + `environment` + `enabled`, not `args`/`env`). Tests: `packages/core/test/plugin/synapse-coder-reporter/` and `packages/core/test/plugin/alterspective-rag-standards/` — run after upstream syncs. Plan + evidence: `docs/implementation/current/SYN-001-synapse-coder-reporter/` (merged PRs #1, #2).
- **Alterspective branding** (TUI): `packages/tui/src/theme/assets/alterspective.json` (brand palette theme, registered in `packages/tui/src/theme/v1.ts`), fork default theme set to `alterspective` in `packages/tui/src/context/theme.tsx`, ALTERSPECTIVE ASCII wordmark in `packages/tui/src/logo.ts` (shared by `util/presentation.ts` epilogue via import), home splash left-aligned per brand rule LOGO-001 in `packages/tui/src/routes/home.tsx`. After upstream syncs touching these files, re-verify the wordmark renders (bun -e render check) and the theme still registers.
- **Local launcher (`opencodealt`)**: machine-local Nodist shim `opencodealt.bat` runs `bun run --conditions=browser` against `packages/cli/src/index.alterspective.ts` (or `packages/opencode/src/index.alterspective.ts` compatibility shim) so the fork starts from any cwd. That entry registers `@opentui/solid/preload` then loads `index.ts` — required because bun only applies `bunfig.toml` preloads from the process cwd. Do not delete the entry without updating the bat.
- **opencodealt release** (#90): `.github/workflows/opencodealt-release.yml` (push to `dev` and manual `workflow_dispatch`, Windows runner) builds `opencodealt.exe` with `OPENCODE_CHANNEL=opencodealt` and `OPENCODE_VERSION=<package version>-alt.<run number>`, then publishes release `opencodealt-v<version>` with `opencodealt-windows-x64.zip` + `.sha256`. AI Office (`aio opencode install`, tool-ai-office#499) installs from it. On that channel `Installation.method()` returns `"aio"` before any package-manager probe (`packages/core/src/installation/opencodealt.ts` and `packages/cli/src/installation/opencodealt.ts`): updates are checked against this repo's releases, auto-update only notifies, and "Update now" / `opencodealt upgrade` runs `aio opencode install`. Never let an opencodealt build fall through to upstream `opencode-ai`. **Channels (#97):** every code merge to `dev` publishes an EDGE pre-release; `opencodealt-promote.yml` (daily, script `.github/scripts/opencodealt-promote.sh`) marks the newest edge as stable (GitHub Latest) after a 3-day soak with no newer edge and no open `release-hold` issue; manual run with a tag promotes or rolls back. A build reads its channel from `<install root>\channel` (written by AI Office) or `OPENCODEALT_RELEASE_CHANNEL`; edge checks all releases, stable checks Latest; it only ever offers a strictly newer version. **`/docs`** (`packages/core/src/plugin/opencodealt-docs.ts`, internal plugin): links the AI Office guide `https://aio.alterspective.com.au/app/ai-os/opencodealt` and answers from the knowledge base; it also adds one system line saying `opencode.ai/docs` is upstream only. The release binary does NOT include this repo's `.opencode/` folder (CAS bridge, project MCPs). Tests: `packages/core/test/installation/installation.test.ts`, `packages/core/test/plugin/opencodealt-docs.test.ts`. Pack: `docs/implementation/current/FEAT-OPENCODEALT-RELEASE/`.
- **CAS bridge** (`.opencode/`): MCP `alterspective-agent` → `https://agent.alterspective.com.au/api/v1/mcp` with **OAuth** (`opencode mcp auth alterspective-agent`, scope `cas.access`, loopback :19876). Tokens from OpenCode `mcp-auth.json` (or optional `CAS_MCP_TOKEN`). Tools: `cas-auth-status`, `cas-select-agent`, `cas-safe-*` (delegate/list/get/cancel + **list-runs / run-insights / run-trace**), `cas-pipeline-status`, **`synapse-probe`** (live `x-synapse-served-model` + rate limits; needs `SYNAPSE_API_KEY`/`GPAAS_API_KEY`). Slash: `/cas`, `/cas-insights`. Façades `cas-delegate` / `cas-drafter` / `cas-matter-audit`. In-repo pack: `docs/implementation/current/FEAT-CAS-OPENCODE-BRIDGE/` (start at `INDEX.md`). **AIO (what we are doing with OpenCode):** `Reference/AI/Capabilities/KB-AI-036-OpenCode-Alterspective-Fork-And-CAS-Bridge.md` in Alterspective-Intelligence. Tests: `packages/core/test/plugin/cas-bridge/`.
- **Windows env**: `turbo.json` `globalPassThroughEnv` includes `NODIST_PREFIX`/`NODIST_X64` — required so the Nodist node shim works under turbo's strict env-mode (the pre-push hook's 30-package typecheck fails without it). Do not remove.
- **Delegate MCP bridge** (`alterspective/delegate-mcp/`, FEAT-OCD-001, #41): local stdio MCP server that lets other AIs drive OpenCode sessions running in a Docker box whose only network exit is an allowlist (Keystone MCP + Synapse + npm + PyPI). **BFA-003 exclusion (approved by the owner, 2026-10-01):** category = local developer tool; condition = stdio only, no remote access, never exposed beyond `127.0.0.1`; approver = owner. A hosted version must add Streamable HTTP + Keystone OAuth first. Plan pack: `docs/implementation/current/FEAT-OCD-001-opencode-delegate-mcp/`. **Full delegation** (#104, owner decision 2026-10-04, replaces R4-01's "never `/mcp/dynamic`" for boxes that choose it): the reserved connection id `dynamic` (`ks-dynamic` → Keystone `/mcp/dynamic`) reaches Keystone only through the `mcp-gate` container (`alterspective/delegate-mcp/mcp-gate/`), which applies the owner's delegation profile (`OPENCODE_DELEGATE_DYNAMIC_PROFILE`, CAS field names, narrow-only) and makes risky tools wait for an approval (`oc_pending` / `oc_answer`, kind `approval`). Needs host-held tokens; the box is not on the gate's network. Policy and risk words are copied from CAS, not shared. **Fork patch** (env-gated, no effect unless `OPENCODE_MCP_ALLOW` is set): `packages/core/src/mcp/allowlist.ts` (new) + small hooks in `mcp/client.ts`, `mcp/connection.ts`, `mcp/index.ts`, `mcp/oauth.ts`, and `mcp/oauth-provider.ts` (`refreshSingleFlightFetch`: one refresh-token grant per token in flight, so Keystone never sees a reused refresh token). After every upstream sync run `bun test test/mcp/allowlist.test.ts test/mcp/allowlist-lifecycle.test.ts test/mcp/refresh-single-flight.test.ts` from `packages/core`. **Synapse model list** (#74, fork-only `packages/core/src/plugin/synapse.ts` + `synapse-models.ts`): the `synapse` provider loads Synapse `GET /v1/models` at startup and merges it into the configured models (the live entry wins where both list a model; a configured model the live list omits is kept and logged as `synapse-models-configured-missing`, because Synapse can leave out a model it still serves and the sandbox pins its stages to configured, whitelisted models, svc#366), always adds `auto`, virtual tiers (`basic`, `standard`, `premium`, `max`), and roles (`role:<name>` / `role/<name>`), never renews a sign-in at startup (expired token or failed fetch: cached `synapse-models.json` in the state folder merged in the same way, else the configured list), and keeps every replaced refresh token so one process never reuses one. Across processes (a TUI plus `opencode serve`, or two TUIs) the refresh grant runs under a machine-wide `Flock` lock keyed on `auth.json` (#75); after taking it the plugin re-reads the stored credential and uses a token another process just rotated instead of spending its own, and the rotated token is saved before the lock is released. A Keystone refresh call gives up after 30 s; a lock wait after 60 s (the chat then keeps its token). Models Synapse marks `capabilities.tools: false` are left out (#80). **Pinned-model fallback** (#80, `synapse-fallback.ts`): a pinned `synapse/<id>` that fails with credit/budget, no tool support, not found/unavailable or rate limit is resent once with `auto` (same body and headers, so `x-privacy-tier: local-only` stays local-only; never for 401/403 or context/validation errors), logged as `FALLBACK_TRIGGERED` (model, reason, status, served model; no token, no text) and shown as a TUI toast, once per session and model. A failed pinned model is then skipped (straight to `auto`) for that session for about 10 minutes (process memory only). The MCP bridge path uses the same classifier. Not in the delegate box: the box does not load this plugin, so Synapse-side failover (Synapse #850 / #1813) handles a failed model. With `stream: true` Synapse sends HTTP 200 and puts the failure in the first SSE event, so the plugin peeks at that first event only (at most 64 KB / 15 s, then the stream is handed on byte for byte) and falls back the same way. Tests write diagnostics under `OPENCODE_TEST_HOME` (or `OPENCODE_DIAGNOSTICS_DIR`), never the real `~/.local/share/opencode/log`. Set `OPENCODE_SYNAPSE_PINNED_FALLBACK=0` to turn it off. **Forced privacy tier** (#101): when `SYNAPSE_PRIVACY_TIER` is set (the sandbox supervisor sets it), every Synapse call the plugin makes carries `local-only`: the REST chat path (set last, so no request or provider header can remove or widen it), the MCP bridge chat path, `synapse_buddy_review` and the model list (the config hook puts it on the `synapse` provider headers). Any non-empty value means `local-only`, so a typo narrows routing and never widens it. After every upstream sync run `bun test test/plugin/synapse-models.test.ts test/plugin/synapse-models-provider.test.ts test/plugin/synapse-fallback.test.ts test/plugin/synapse-privacy-tier.test.ts` from `packages/core`. **Quality loop surfaces (iter 0-14, design rev 7):** host learning loop in `src/reporting/` (task records, share-weighted scorecard, serving-history D4 role picks with the dead firewall, `role-quality` guard that retires the client tie-break when Synapse's table bakes - the anti-duplication deal, see `docs/implementation/current/FEAT-OCD-001-opencode-delegate-mcp/evidence/quality-loop-2026-10-12.md`); branded 4-view owner dashboard (`oc_dashboard`, `opencode-delegate dashboard`; self-hosted brand fonts with probe `spike/font-evidence.ts`); 30-day log sweep; watcher supervisor with `ocd-watch.status.json`. After upstream syncs run `bun test test/dashboard.test.ts test/open-once.test.ts test/role-quality.test.ts test/reporting-store.test.ts` from `alterspective/delegate-mcp` (no symlinks needed; fonts/assets ship in-tree).
- **Fast-cycle delivery** (#93, KB playbook `Practice/AI/playbooks/AIPB-008-Fast-Cycle-Delivery-And-Pipeline-Acceleration.md`): do not run the full `packages/core` suite locally to check a change. On this Windows box it takes 10+ minutes and fails in many places unrelated to any change. Use the tiers instead. **Tier 1 (seconds):** `bun run test:fast` from the repo root (`script/test-fast.ts`) runs oxlint on the changed files and only the tests mapped to them; `--list` shows the plan, `--base <ref>` changes the comparison (default `origin/dev`). **Tier 1 in CI:** the `fast` job of `.github/workflows/alterspective-fast-cycle.yml` runs the same on every PR, plus the typecheck. **Tier 2:** its `full` job runs the whole `packages/core` suite on GitHub-hosted Linux for every PR and every push to `dev` as 4 parallel `full shard N/4` jobs (`bun test --shard`, split by file). Upstream tests that must not see the fork's own built-in plugins (Synapse, /goal, /docs) set `RuntimeFlags.layer({ disableForkPlugins: true })` or `OPENCODE_DISABLE_FORK_PLUGINS=true`. No merge queue: it needs an organisation-owned repository and this fork is user-owned.
- **Symlinks**: Windows has no symlink privilege here, so repo symlinks check out as text placeholders. The two typecheck-blocking ones (`packages/app/src/custom-elements.d.ts`, `packages/enterprise/src/custom-elements.d.ts`) are replaced with local hardlinks hidden via `git update-index --skip-worktree` (list them: `git ls-files -v | Select-String '^S'`). ~60 asset symlinks (favicons etc.) remain placeholders — harmless for typecheck/TUI, but app/web builds serving those assets need Developer Mode enabled first.
- **Small model context protection & delegation** (`packages/core/src/plugin/small-model-delegation.ts`): protects models with small context windows (default threshold <= 300,000 tokens, e.g. local models running on RTX 5090 / `coder-svr`) from context exhaustion. Uses a two-tier mechanism: (1) prompt guidance via `experimental.chat.system.transform` directing the primary agent to delegate broad file searches and code exploration to the `explore` subagent; (2) active tool bouncer via `tool.execute.before` blocking direct calls to `grep` and `read` in primary sessions, guiding the model with an exact `subagent` / `task` tool invocation example. Subagents (`parentSessionID` present, max depth 1) run unrestricted with full tool access and return concise syntheses to keep primary context clean. Configurable via `OPENCODE_SMALL_MODEL_THRESHOLD` (number of tokens), `OPENCODE_SMALL_MODEL_DELEGATION` (0 to disable), or `opencode.jsonc` `experimental.small_model_context_threshold`. Supported across Web UI, TUI, CLI, `coder-svr`, and Docker sandbox (`opencode-delegate` env passthrough). Tests: `bun test test/plugin/small-model-delegation.test.ts` from `packages/core`.
- **Tool-output secret redaction** (#26, fork-only `packages/core/src/util/secret-redaction.ts`, re-exported from `packages/core/src/plugin/secret-redaction.ts`): high-confidence credentials become `[REDACTED:<kind>]` in the core session projector (`packages/core/src/session/projector.ts`), `Session.shell` notifications (`packages/core/src/session/session.ts`), and the Synapse plugin's `tool.execute.after` hook. After every upstream sync check the projector hook is still in place and run `bun test test/plugin/secret-redaction.test.ts test/session-projector.test.ts` from `packages/core`.
- **Observer MCP failures & Learning store** (#18, #38, #212, #216, #217, fork-only `packages/core/src/plugin/observer.ts` and `synapse.ts`): after every upstream sync run `bun test test/plugin/observer.test.ts` from `packages/core`.
- **Unset `{env:VAR}` in config is named** (#24, fork-only `packages/core/src/config/unset-env.ts`, called in `packages/core/src/config.ts` before `ConfigVariable.substitute`): after an upstream sync check the call is still before the substitution and run `bun test test/config/unset-env.test.ts` from `packages/core`.
- **Deleting a session stops its run & drops late events** (#176, #214, fork-only `packages/core/src/session/cancel-tree.ts`, `packages/core/src/session/deleting.ts`, `packages/core/src/session.ts`, `packages/client/src/solid/data.ts`, and `packages/client/src/solid/deleted-sessions.ts`): after every upstream sync run `bun test test/session/cancel-tree.test.ts` from `packages/core` and `bun test test/cli/cmd/tui/sync-deleted-session-late-events.test.tsx` from `packages/tui`.
- **TUI part window** (#215, fork-only `packages/client/src/solid/part-window.ts`): run `bun test test/cli/cmd/tui/sync-part-window.test.tsx` from `packages/tui`.
- **Synapse transport stall** (#262, fork-only `packages/core/src/session/runner/retry.ts`, `packages/core/src/session/runner/step.ts`, `packages/core/src/session/parent-alert.ts`, `packages/tui/src/feature-plugins/system/notifications.ts`, and `packages/app/src/shell/notifications/notification.tsx`): after every upstream sync run `bun test test/session-runner-retry.test.ts` from `packages/core` and `bun test test/cli/cmd/tui/notifications.test.ts` from `packages/tui`.
- **Synapse context overflow** (#196, #200, `packages/ai/src/provider-error.ts`, `packages/core/src/github-copilot/openai-compatible-error.ts`, `packages/core/src/session/error.ts`): after every upstream sync run `bun test test/provider-error.test.ts` from `packages/ai` and `bun test test/session-error.test.ts` from `packages/core`.
- **Scheduled tasks and subagent goal loops** (#243, #267, fork-only `packages/core/src/tool/plugin/schedule.ts`, `packages/core/src/plugin/goal.ts`, `packages/core/src/plugin/goal-loop.ts`, `packages/core/src/plugin/tick-guard.ts`, and `packages/core/src/tool/plugin/subagent.ts`): after every upstream sync run `bun test test/plugin/schedule.test.ts test/plugin/goal-loop.test.ts test/plugin/goal-loop-step.test.ts test/plugin/tick-guard.test.ts test/tool-subagent.test.ts` from `packages/core`.
- **Sandbox shell timeout cap** (#249, svc-coding-agent#539, fork-only `alterspective/sandbox-worker/plugins/shell-timeout-cap.ts`, installed by `supervisor/main.ts`): run `bun test` from `alterspective/sandbox-worker`.
- **Parent check-in during a foreground task** (#268, fork-only `packages/core/src/session/prompt-foreground-task.ts` and `packages/core/src/tool/plugin/subagent.ts`): after every upstream sync run `bun test test/tool-subagent.test.ts` from `packages/core`.
- **Synapse built-in provider, OOB default & `/connect` Popular ordering** (#289, #291, `packages/core/src/plugin/provider/synapse.ts`, `packages/core/src/plugin/provider/index.ts`, `packages/core/src/plugin/synapse.ts`, `packages/core/src/model/model.ts`, `packages/tui/src/feature-plugins/home/model.tsx`, `packages/tui/src/feature-plugins/providers/index.tsx`, `packages/app/src/components/dialog-select-provider.tsx`, `packages/cli/src/cmd/auth.ts`): `SynapseProviderPlugin` registers `synapse` (`Alterspective Synapse`) in the built-in catalog with `auto`, `basic`, `standard`, `premium`, and `max` tiers plus default `baseURL: "https://synapse2-api.alterspective.com.au/v1"`. Out-of-the-box `opencode` free models (`apiKey: "public"`) use `activation: "auto"` instead of `"always"`, and `Model.default()` prefers `synapse/auto` out of the box. `/connect` (TUI & web/desktop) and `opencodealt auth login` list **Alterspective Synapse** first under **Popular**, while keeping fallback providers selectable in `/connect` if Synapse is offline. Both Keystone SSO and API key sign-in synchronize V2 `Credential.Service` (SQLite) and `auth.json` under a shared file lock, and the TUI model store retries cold-start `503` catalog fetches on `server.connected` and `global.disposed`. After every upstream sync run `bun test test/plugin/provider-synapse.test.ts` from `packages/core` and `bun test test/cli/cmd/tui/model-ColdStartRetry.test.tsx` from `packages/tui`.
- The remediation plan and full revalidation evidence live in `specs/arch-remediation-plan.md`.
