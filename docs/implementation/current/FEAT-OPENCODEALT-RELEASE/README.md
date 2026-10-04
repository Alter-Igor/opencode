# FEAT-OPENCODEALT-RELEASE — opencodealt as an installable binary (#90)

**opencodealt** is this fork. Upstream docs (`https://opencode.ai/docs`) cover upstream OpenCode only.

## What ships

| Part | Where | What it does |
|---|---|---|
| Release workflow | `.github/workflows/opencodealt-release.yml` | Manual run. Builds `opencodealt.exe` (Windows x64) on a Windows runner, checks `--version`, publishes release `opencodealt-v<version>` with `opencodealt-windows-x64.zip` and `opencodealt-windows-x64.zip.sha256`. Version is `<packages/opencode version>-alt.<run number>`. Not code-signed. |
| Update channel | `packages/opencode/src/installation/opencodealt.ts`, `installation/index.ts` | On channel `opencodealt` the install method is `aio`. It checks `Alter-Igor/opencode` releases, never upstream `opencode-ai`. Auto-update only notifies. "Update now" and `opencodealt upgrade` run `aio opencode install`. |
| `/docs` | `packages/opencode/src/plugin/opencodealt-docs.ts` | `/docs` links the AI Office guide. `/docs <question>` answers from the knowledge base (alterspective-rag tools when connected). Also adds one system line: opencode.ai/docs is upstream only. |

## Contract with AI Office (tool-ai-office#499)

- Latest release: `GET https://api.github.com/repos/Alter-Igor/opencode/releases/latest`.
- Asset `opencodealt-windows-x64.zip` holds `opencodealt.exe` at the root. The `.sha256` file is `<hex>  opencodealt-windows-x64.zip`.
- `aio opencode install` must replace a running `opencodealt.exe` (rename it to `.old`, then move the new one in).

## Not in the binary

This repo's `.opencode/` folder (CAS bridge tools, project MCP list, project plugins) loads only when opencodealt runs inside a clone of this repo.

## How to release

1. Merge to `dev`.
2. Actions → `opencodealt-release` → Run workflow (default ref `dev`).
3. Check the release has both files, then run `aio opencode install` on a test machine.

## Evidence (2026-10-04, local, before the PR)

- Local build: `OPENCODE_CHANNEL=opencodealt OPENCODE_VERSION=1.18.31-alt.0 bun run --cwd packages/opencode script/build.ts --single --skip-install` → smoke test `1.18.31-alt.0`.
- `opencodealt.exe upgrade` with no release published: "Using method: aio", then "Could not find the latest release", exit without a crash.
- `opencodealt.exe debug config` lists the `docs` command.
- `opencodealt.exe run --command docs "what does /goal do?"` (Synapse `auto`): reply starts with the guide link, used `rag_search` + `rag_get_articles`, cited OPS-004-03.
- The release workflow itself has not run yet; it can only be started once it is on `dev`.
