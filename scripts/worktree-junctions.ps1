<#
.SYNOPSIS
Creates NTFS directory junctions for root and workspace node_modules in a Git worktree (#201).

.DESCRIPTION
Bun 1.3.14 crashes with an internal assertion failure during `bun install` on Windows in git worktrees
(and on subst drives). This helper links `node_modules` at the worktree root and under every workspace
package configured in `package.json` (`workspaces.packages`, including nested workspaces such as
`packages/console/*`, `packages/stats/*`, `packages/sdk/js`, plus `alterspective/*`) to the existing
`node_modules` directories in the primary repository checkout so tests and typechecks can run without
invoking `bun install`.

NOTE ON WORKSPACE SYMLINKS (`@opencode-ai/*`):
Because NTFS directory junctions point directly to `$MainRepoPath\...\node_modules`, this script
intentionally treats the target `node_modules` trees as shared and read-only: it NEVER rewrites
`node_modules/@opencode-ai/*` entries inside a junctioned `node_modules` directory, because doing so
would mutate the primary checkout's `node_modules` in `$MainRepoPath` and break the main worktree or
sibling worktrees. Package-local `tsconfig.json` paths and relative imports within each worktree
resolve local TypeScript sources directly during `bun typecheck` and `bun test`.

.PARAMETER WorktreePath
Path to the target git worktree. Defaults to the repository root of the current script or directory.

.PARAMETER MainRepoPath
Optional path to the primary repository checkout containing installed `node_modules`. Defaults to the
first (primary) worktree reported by `git worktree list --porcelain`.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $false, Position = 0)]
    [string]$WorktreePath = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,

    [Parameter(Mandatory = $false)]
    [string]$MainRepoPath = ""
)

$ErrorActionPreference = "Stop"

$resolvedWorktree = (Resolve-Path -LiteralPath $WorktreePath).Path

if ([string]::IsNullOrWhiteSpace($MainRepoPath)) {
    $porcelain = & git -C $resolvedWorktree worktree list --porcelain 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $porcelain) {
        throw "Could not determine primary worktree from 'git worktree list --porcelain' in '$resolvedWorktree'."
    }
    $firstWorktreeLine = $porcelain | Where-Object { $_ -like "worktree *" } | Select-Object -First 1
    if (-not $firstWorktreeLine) {
        throw "No worktree entry found in 'git worktree list --porcelain' output."
    }
    $rawPath = ($firstWorktreeLine -replace "^worktree\s+", "").Trim()
    $MainRepoPath = [System.IO.Path]::GetFullPath($rawPath)
} else {
    $MainRepoPath = (Resolve-Path -LiteralPath $MainRepoPath).Path
}

if (-not (Test-Path -LiteralPath (Join-Path $MainRepoPath "node_modules"))) {
    throw "Main checkout at '$MainRepoPath' does not have a root node_modules directory."
}

$workspacePatterns = [System.Collections.Generic.List[string]]::new()
$rootPackageJsonPath = Join-Path $MainRepoPath "package.json"
if (Test-Path -LiteralPath $rootPackageJsonPath) {
    $pkg = Get-Content -LiteralPath $rootPackageJsonPath -Raw | ConvertFrom-Json
    if ($pkg.workspaces) {
        if ($pkg.workspaces -is [System.Array]) {
            foreach ($entry in $pkg.workspaces) {
                if ($entry) { $workspacePatterns.Add([string]$entry) }
            }
        } elseif ($pkg.workspaces.packages) {
            foreach ($entry in $pkg.workspaces.packages) {
                if ($entry) { $workspacePatterns.Add([string]$entry) }
            }
        }
    }
}

if ($workspacePatterns.Count -eq 0) {
    foreach ($fallback in @("packages/*", "packages/console/*", "packages/stats/*", "packages/sdk/js", "packages/slack")) {
        $workspacePatterns.Add($fallback)
    }
}
$workspacePatterns.Add("alterspective/*")

$seenRelativePaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
$relativePaths = [System.Collections.Generic.List[string]]::new()

function Add-RelativeNodeModules([string]$relPath) {
    $normalized = $relPath.Replace("/", [System.IO.Path]::DirectorySeparatorChar)
    if ($seenRelativePaths.Add($normalized)) {
        $relativePaths.Add($normalized)
    }
}

Add-RelativeNodeModules "node_modules"

foreach ($pattern in $workspacePatterns) {
    $normalizedPattern = $pattern.Replace("/", [System.IO.Path]::DirectorySeparatorChar)
    $searchPath = Join-Path $MainRepoPath $normalizedPattern
    if ($normalizedPattern.Contains("*")) {
        $parentDir = Split-Path -Parent $searchPath
        $leafFilter = Split-Path -Leaf $searchPath
        if (Test-Path -LiteralPath $parentDir) {
            Get-ChildItem -LiteralPath $parentDir -Filter $leafFilter -Directory | ForEach-Object {
                $relWorkspace = [System.IO.Path]::GetRelativePath($MainRepoPath, $_.FullName)
                $candidate = Join-Path $relWorkspace "node_modules"
                if (Test-Path -LiteralPath (Join-Path $MainRepoPath $candidate)) {
                    Add-RelativeNodeModules $candidate
                }
            }
        }
    } else {
        $candidate = Join-Path $normalizedPattern "node_modules"
        if (Test-Path -LiteralPath (Join-Path $MainRepoPath $candidate)) {
            Add-RelativeNodeModules $candidate
        }
    }
}

$created = 0
$skipped = 0

foreach ($rel in $relativePaths) {
    $sourceDir = Join-Path $MainRepoPath $rel
    $targetDir = Join-Path $resolvedWorktree $rel
    $targetParent = Split-Path -Parent $targetDir

    if (-not (Test-Path -LiteralPath $sourceDir)) {
        continue
    }
    if (-not (Test-Path -LiteralPath $targetParent)) {
        continue
    }
    if (Test-Path -LiteralPath $targetDir) {
        $skipped += 1
        continue
    }

    # Create a directory junction to $sourceDir without mutating internal links inside $sourceDir.
    New-Item -ItemType Junction -Path $targetDir -Target $sourceDir | Out-Null
    Write-Host "Linked junction: $targetDir -> $sourceDir"
    $created += 1
}

Write-Host "Worktree junctions ready for '$resolvedWorktree' (created: $created, existing: $skipped, source: '$MainRepoPath')."
