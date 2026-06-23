#Requires -Version 5.1
<#
.SYNOPSIS
    AI Mind Map — One-line installer for Windows.

.DESCRIPTION
    Installs the AI Mind Map MCP server by cloning the repository,
    building from source, and optionally configuring detected AI agents.

.PARAMETER InstallDir
    Custom installation directory. Default: $env:USERPROFILE\.ai-mind-map

.PARAMETER SkipConfig
    Skip automatic AI agent configuration.

.PARAMETER Update
    Force update mode — pulls latest changes and rebuilds.

.EXAMPLE
    # Default install
    .\install.ps1

    # Custom directory
    .\install.ps1 -InstallDir "D:\tools\ai-mind-map"

    # Update existing installation
    .\install.ps1 -Update

.LINK
    https://github.com/shdra06/ai-mind-map
#>
[CmdletBinding()]
param(
    [string]$InstallDir = "",
    [switch]$SkipConfig,
    [switch]$Update
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Constants ────────────────────────────────────────────────────────────────
$REPO_URL        = "https://github.com/shdra06/ai-mind-map.git"
$MIN_NODE_MAJOR  = 18
$ENTRY_POINT     = "dist\index.js"

# ── Banner ───────────────────────────────────────────────────────────────────
function Show-Banner {
    $banner = @"

     █████╗ ██╗    ███╗   ███╗██╗███╗   ██╗██████╗     ███╗   ███╗ █████╗ ██████╗
    ██╔══██╗██║    ████╗ ████║██║████╗  ██║██╔══██╗    ████╗ ████║██╔══██╗██╔══██╗
    ███████║██║    ██╔████╔██║██║██╔██╗ ██║██║  ██║    ██╔████╔██║███████║██████╔╝
    ██╔══██║██║    ██║╚██╔╝██║██║██║╚██╗██║██║  ██║    ██║╚██╔╝██║██╔══██║██╔═══╝
    ██║  ██║██║    ██║ ╚═╝ ██║██║██║ ╚████║██████╔╝    ██║ ╚═╝ ██║██║  ██║██║
    ╚═╝  ╚═╝╚═╝    ╚═╝     ╚═╝╚═╝╚═╝  ╚═══╝╚═════╝     ╚═╝     ╚═╝╚═╝  ╚═╝╚═╝

    MCP Server — Reduce AI token usage by 80-99%%
    https://github.com/shdra06/ai-mind-map

"@
    Write-Host $banner -ForegroundColor Cyan
}

# ── Helpers ──────────────────────────────────────────────────────────────────
function Write-Step   { param([string]$Msg) Write-Host "  [*] $Msg" -ForegroundColor Blue }
function Write-Ok     { param([string]$Msg) Write-Host "  [✓] $Msg" -ForegroundColor Green }
function Write-Warn   { param([string]$Msg) Write-Host "  [!] $Msg" -ForegroundColor Yellow }
function Write-Err    { param([string]$Msg) Write-Host "  [✗] $Msg" -ForegroundColor Red }

function Test-CommandExists {
    param([string]$Command)
    $null -ne (Get-Command $Command -ErrorAction SilentlyContinue)
}

function Invoke-StepCommand {
    param([string]$Label, [string]$Exe, [string[]]$Arguments, [string]$WorkDir)
    Write-Step $Label
    $psi = @{
        FilePath     = $Exe
        ArgumentList = $Arguments
        WorkingDirectory = $WorkDir
        NoNewWindow  = $true
        Wait         = $true
        PassThru     = $true
    }
    $proc = Start-Process @psi
    if ($proc.ExitCode -ne 0) {
        Write-Err "$Label failed with exit code $($proc.ExitCode)."
        exit 1
    }
}

# ── Pre-flight Checks ───────────────────────────────────────────────────────
function Assert-Prerequisites {
    Write-Host "`n  Checking prerequisites..." -ForegroundColor White

    # Node.js
    if (-not (Test-CommandExists "node")) {
        Write-Err "Node.js is not installed."
        Write-Err "Download it from: https://nodejs.org (v$MIN_NODE_MAJOR or later)"
        exit 1
    }
    $nodeVersionRaw = (node --version 2>&1).ToString().Trim()
    $nodeMatch = [regex]::Match($nodeVersionRaw, 'v(\d+)\.')
    if (-not $nodeMatch.Success) {
        Write-Err "Could not determine Node.js version from: $nodeVersionRaw"
        exit 1
    }
    $nodeMajor = [int]$nodeMatch.Groups[1].Value
    if ($nodeMajor -lt $MIN_NODE_MAJOR) {
        Write-Err "Node.js v$MIN_NODE_MAJOR+ is required. Found: $nodeVersionRaw"
        Write-Err "Download the latest LTS from: https://nodejs.org"
        exit 1
    }
    Write-Ok "Node.js $nodeVersionRaw"

    # npm (comes with Node, but verify)
    if (-not (Test-CommandExists "npm")) {
        Write-Err "npm is not installed. It should come with Node.js — try reinstalling Node."
        exit 1
    }
    $npmVersion = (npm --version 2>&1).ToString().Trim()
    Write-Ok "npm v$npmVersion"

    # Git
    if (-not (Test-CommandExists "git")) {
        Write-Err "Git is not installed."
        Write-Err "Download it from: https://git-scm.com/download/win"
        exit 1
    }
    $gitVersion = (git --version 2>&1).ToString().Trim()
    Write-Ok "$gitVersion"
}

# ── Installation ─────────────────────────────────────────────────────────────
function Install-AiMindMap {
    $targetDir = if ($InstallDir -ne "") { $InstallDir } else { Join-Path $env:USERPROFILE ".ai-mind-map" }
    $isExisting = Test-Path (Join-Path $targetDir ".git")

    # Decide: fresh install or update
    if ($isExisting -and -not $Update) {
        Write-Warn "AI Mind Map is already installed at: $targetDir"
        $choice = Read-Host "  Update to latest version? (Y/n)"
        if ($choice -match '^[Nn]') {
            Write-Host "`n  Installation cancelled." -ForegroundColor Gray
            exit 0
        }
        $Update = $true
    }

    if ($Update -and $isExisting) {
        # ── Update path ──────────────────────────────────────────────────
        Write-Host "`n  Updating AI Mind Map..." -ForegroundColor White
        Write-Step "Pulling latest changes..."
        $gitPull = Start-Process -FilePath "git" -ArgumentList "pull","--ff-only" `
            -WorkingDirectory $targetDir -NoNewWindow -Wait -PassThru
        if ($gitPull.ExitCode -ne 0) {
            Write-Warn "Fast-forward pull failed. Trying git pull --rebase..."
            $gitRebase = Start-Process -FilePath "git" -ArgumentList "pull","--rebase" `
                -WorkingDirectory $targetDir -NoNewWindow -Wait -PassThru
            if ($gitRebase.ExitCode -ne 0) {
                Write-Err "Git pull failed. You may have local changes."
                Write-Err "Resolve manually in: $targetDir"
                exit 1
            }
        }
        Write-Ok "Repository updated"
    }
    else {
        # ── Fresh install ────────────────────────────────────────────────
        Write-Host "`n  Installing AI Mind Map..." -ForegroundColor White
        Write-Step "Cloning repository to: $targetDir"
        if (Test-Path $targetDir) {
            Write-Warn "Directory exists but is not a git repo. Removing..."
            Remove-Item -Recurse -Force $targetDir
        }
        $gitClone = Start-Process -FilePath "git" -ArgumentList "clone",$REPO_URL,$targetDir `
            -NoNewWindow -Wait -PassThru
        if ($gitClone.ExitCode -ne 0) {
            Write-Err "Failed to clone repository."
            Write-Err "Check your internet connection and try again."
            exit 1
        }
        Write-Ok "Repository cloned"
    }

    # ── Install dependencies ─────────────────────────────────────────────
    Invoke-StepCommand -Label "Installing dependencies (this may take a minute)..." `
        -Exe "npm" -Arguments @("install","--legacy-peer-deps") -WorkDir $targetDir
    Write-Ok "Dependencies installed"

    # ── Build ────────────────────────────────────────────────────────────
    Invoke-StepCommand -Label "Building TypeScript..." `
        -Exe "npx" -Arguments @("tsc") -WorkDir $targetDir
    Write-Ok "Build complete"

    # ── Verify build ─────────────────────────────────────────────────────
    $entryFile = Join-Path $targetDir $ENTRY_POINT
    if (-not (Test-Path $entryFile)) {
        Write-Err "Build verification failed: $ENTRY_POINT not found."
        Write-Err "Please report this issue: https://github.com/shdra06/ai-mind-map/issues"
        exit 1
    }
    Write-Ok "Build verified ($ENTRY_POINT exists)"

    # ── PATH management ──────────────────────────────────────────────────
    Add-ToUserPath -Dir $targetDir

    # ── Agent configuration ──────────────────────────────────────────────
    if (-not $SkipConfig) {
        Configure-Agents -Dir $targetDir
    }

    # ── Done ─────────────────────────────────────────────────────────────
    Show-Success -Dir $targetDir
}

# ── PATH ─────────────────────────────────────────────────────────────────────
function Add-ToUserPath {
    param([string]$Dir)

    $currentPath = [Environment]::GetEnvironmentVariable("PATH", "User")
    if ($currentPath -and $currentPath.Split(';') -contains $Dir) {
        Write-Ok "Install directory already in PATH"
        return
    }

    try {
        $newPath = if ($currentPath) { "$currentPath;$Dir" } else { $Dir }
        [Environment]::SetEnvironmentVariable("PATH", $newPath, "User")
        # Also update current session
        $env:PATH = "$env:PATH;$Dir"
        Write-Ok "Added to user PATH: $Dir"
        Write-Warn "Restart your terminal for PATH changes to take effect."
    }
    catch {
        Write-Warn "Could not update PATH automatically."
        Write-Warn "Manually add this directory to your PATH: $Dir"
    }
}

# ── Agent Auto-Configuration ────────────────────────────────────────────────
function Configure-Agents {
    param([string]$Dir)

    Write-Host "`n  Detecting AI agents..." -ForegroundColor White

    $agents = @()

    # Claude Desktop / Claude Code
    $claudeConfig = Join-Path $env:APPDATA "Claude\claude_desktop_config.json"
    if (Test-Path $claudeConfig) { $agents += "Claude Desktop" }
    $claudeCodeDir = Join-Path $env:USERPROFILE ".claude"
    if (Test-Path $claudeCodeDir) { $agents += "Claude Code" }

    # Cursor
    $cursorDir = Join-Path $env:USERPROFILE ".cursor"
    if (Test-Path $cursorDir) { $agents += "Cursor" }

    # VS Code
    $vscodeDir = Join-Path $env:APPDATA "Code\User"
    if (Test-Path $vscodeDir) { $agents += "VS Code" }

    # Windsurf / Codeium
    $windsurfDir = Join-Path $env:APPDATA "Windsurf"
    if (Test-Path $windsurfDir) { $agents += "Windsurf" }

    if ($agents.Count -eq 0) {
        Write-Warn "No AI agents detected. See README for manual setup."
        return
    }

    Write-Ok "Detected: $($agents -join ', ')"
    Write-Host ""
    Write-Host "  To configure an agent, add this to its MCP config:" -ForegroundColor White
    $escapedDir = ($Dir -replace '\\', '\\')
    Write-Host @"

    {
      "mcpServers": {
        "ai-mind-map": {
          "command": "node",
          "args": [
            "$escapedDir\\dist\\index.js",
            "--project-root",
            "<YOUR_PROJECT_PATH>"
          ]
        }
      }
    }

"@ -ForegroundColor Gray
}

# ── Success ──────────────────────────────────────────────────────────────────
function Show-Success {
    param([string]$Dir)

    $divider = "─" * 60
    Write-Host ""
    Write-Host "  $divider" -ForegroundColor Green
    Write-Host "  ✅  AI Mind Map installed successfully!" -ForegroundColor Green
    Write-Host "  $divider" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Location:  $Dir" -ForegroundColor White
    Write-Host ""
    Write-Host "  Next steps:" -ForegroundColor White
    Write-Host "    1. Configure your AI agent (see above or README)" -ForegroundColor Gray
    Write-Host "    2. Test with:  node `"$Dir\$ENTRY_POINT`" --project-root ." -ForegroundColor Gray
    Write-Host "    3. Star the repo: https://github.com/shdra06/ai-mind-map" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  To update later:  .\install.ps1 -Update" -ForegroundColor Yellow
    Write-Host "  Full docs:        https://github.com/shdra06/ai-mind-map#readme" -ForegroundColor Yellow
    Write-Host ""
}

# ── Main ─────────────────────────────────────────────────────────────────────
Show-Banner
Assert-Prerequisites
Install-AiMindMap
