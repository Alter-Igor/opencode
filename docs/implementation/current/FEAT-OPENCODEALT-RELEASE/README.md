# FEAT-OPENCODEALT-RELEASE — opencodealt as an installable binary (#90)

**opencodealt** is this fork. Upstream docs (`https://opencode.ai/docs`) cover upstream OpenCode only.

## What ships

| Part | Where | What it does |
|---|---|---|
| Release workflow | `.github/workflows/opencodealt-release.yml` | Runs on code merge to `dev` and manual `workflow_dispatch`. Builds `opencodealt.exe` (Windows x64) on a Windows runner, checks `--version`, publishes release `opencodealt-v<version>` with `opencodealt-windows-x64.zip` and `opencodealt-windows-x64.zip.sha256`. Version is `<packages/cli version>-alt.<run number>` (for example `2.2.5-alt.93`). Not code-signed. |
| Update channel | `packages/core/src/installation/opencodealt.ts`, `packages/cli/src/installation/opencodealt.ts` | On channel `opencodealt` the install method is `aio`. It checks `Alter-Igor/opencode` releases, never upstream `opencode-ai`. Auto-update only notifies. "Update now" and `opencodealt upgrade` run `aio opencode install`. |
| `/docs` | `packages/core/src/plugin/opencodealt-docs.ts` | `/docs` links the AI Office guide (`https://aio.alterspective.com.au/app/ai-os/opencodealt`). `/docs <question>` answers from the knowledge base (alterspective-rag tools when connected). Also adds one system line: `opencode.ai/docs` is upstream only. |
| Synapse OOB default & `/connect` | `packages/core/src/plugin/provider/synapse.ts`, `packages/core/src/plugin/synapse.ts`, `packages/core/src/model/model.ts` | Built-in `synapse` provider (`Alterspective Synapse`) with `synapse/auto` as the default model out of the box (unconnected `opencode` free models are restricted). Listed first under **Popular** in `/connect` and `opencodealt auth login` (Keystone SSO or API key), while keeping fallback providers selectable in `/connect` if Synapse is offline (#291). |
| Cold-start catalog retry | `packages/tui/src/feature-plugins/home/model.tsx` | Retries `client.provider.list()` on `server.connected` and `global.disposed` if the background server returned `503` during cold start (#289). |

## Contract with AI Office (tool-ai-office#499)

- Latest release: `GET https://api.github.com/repos/Alter-Igor/opencode/releases/latest`.
- Asset `opencodealt-windows-x64.zip` holds `opencodealt.exe` at the root. The `.sha256` file is `<hex>  opencodealt-windows-x64.zip`.
- `aio opencode install` must replace a running `opencodealt.exe` (rename it to `.old`, then move the new one in).

## Not in the binary

This repo's `.opencode/` folder (CAS bridge tools, project MCP list, project plugins) loads only when opencodealt runs inside a clone of this repo.

## Channels (#97)

| Channel | What it is | Who gets it |
|---|---|---|
| **edge** | Every code merge to `dev` builds and publishes a GitHub **pre-release** (`opencodealt-release.yml`; docs-only changes are skipped). | People who chose `aio opencode install --edge` |
| **stable** | An edge release promoted to a normal release marked **Latest**. Same files, no rebuild. | Everyone else (the default) |

**Promotion** (`opencodealt-promote.yml`, daily 07:17 AEST, script `.github/scripts/opencodealt-promote.sh`): the newest release is promoted when it is a pre-release, at least 3 days old, and no issue labelled `release-hold` is open. "Newest" means no newer edge build has landed since, so a busy week waits for a quiet one.

- **Stop promotions:** open an issue labelled `release-hold`. Close it to resume.
- **Promote now / roll back:** Actions → `opencodealt-promote` → Run with `tag` set. An older tag makes that release Latest again.
- **Dry run:** the same, with `dry_run` ticked.

**Inside opencodealt:** the build reads its channel from `<install root>\channel` (AI Office writes it) or `OPENCODEALT_RELEASE_CHANNEL`. Edge checks all releases; stable checks Latest. It only ever offers a strictly newer version, so an edge build is never asked to step back to stable. `opencodealt upgrade` follows the same rule.

## How to release by hand

Not needed any more: merges release themselves. To build a specific commit: Actions → `opencodealt-release` → Run workflow with `ref`.

## Evidence (2026-10-04, local, before the PR)

- Local build: `OPENCODE_CHANNEL=opencodealt OPENCODE_VERSION=1.18.31-alt.0 bun run --cwd packages/opencode script/build.ts --single --skip-install` → smoke test `1.18.31-alt.0`.
- `opencodealt.exe upgrade` with no release published: "Using method: aio", then "Could not find the latest release", exit without a crash.
- `opencodealt.exe debug config` lists the `docs` command.
- `opencodealt.exe run --command docs "what does /goal do?"` (Synapse `auto`): reply starts with the guide link, used `rag_search` + `rag_get_articles`, cited OPS-004-03.
- The release workflow itself has not run yet; it can only be started once it is on `dev`.
