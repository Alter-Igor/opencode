<#
.SYNOPSIS
Creates NTFS directory junctions for root and workspace node_modules in a Git worktree (#201).

.DESCRIPTION
Bun 1.3.14 crashes with an internal assertion failure during `bun install` on Windows in git worktrees
(and on subst drives). This helper links `node_modules` at the worktree root and under every workspace
package (`packages/*/node_modules`, `alterspective/*/node_modules`) to the existing `node_modules`
directories in the primary repository checkout so tests and typechecks can run without `bun install`.

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

$relativePaths = [System.Collections.Generic.List[string]]::new()
$relativePaths.Add("node_modules")

foreach ($workspaceGroup in @("packages", "alterspective")) {
    $groupDir = Join-Path $MainRepoPath $workspaceGroup
    if (Test-Path -LiteralPath $groupDir) {
        Get-ChildItem -LiteralPath $groupDir -Directory | ForEach-Object {
            $candidate = Join-Path $workspaceGroup (Join-Path $_.Name "node_modules")
            $sourceCandidate = Join-Path $MainRepoPath $candidate
            if (Test-Path -LiteralPath $sourceCandidate) {
                $relativePaths.Add($candidate)
            }
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

    New-Item -ItemType Junction -Path $targetDir -Target $sourceDir | Out-Null
    Write-Host "Linked junction: $targetDir -> $sourceDir"
    $created += 1
}

Write-Host "Worktree junctions ready for '$resolvedWorktree' (created: $created, existing: $skipped, source: '$MainRepoPath')."
