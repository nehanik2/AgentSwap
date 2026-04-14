# =============================================================================
# AgentSwap — record-demo.ps1
# Auto-records a walkthrough of the AgentSwap dashboard using OBS CLI.
#
# Prerequisites:
#   1. OBS Studio installed (https://obsproject.com)
#   2. obs-websocket plugin enabled in OBS (built-in since OBS 28)
#   3. AgentSwap dashboard running at http://localhost:3000
#   4. Run this script AFTER: bash scripts/start-demo.sh --skip-docker
#
# Usage (PowerShell as Administrator):
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   .\scripts\record-demo.ps1
#
# Output: $env:USERPROFILE\Videos\agentswap-demo.mkv
# =============================================================================

param(
    [string]$ObsPath     = "C:\Program Files\obs-studio\bin\64bit\obs64.exe",
    [string]$DashboardUrl = "http://localhost:3000",
    [string]$OutputDir   = "$env:USERPROFILE\Videos",
    [string]$OutputFile  = "agentswap-demo.mkv",
    [int]   $OBSPort     = 4455,
    [string]$OBSPassword = ""        # set if you enabled auth in OBS websocket
)

# ── Colours ───────────────────────────────────────────────────────────────────
function Log  ($msg) { Write-Host "[demo] $msg" -ForegroundColor Cyan }
function Ok   ($msg) { Write-Host "[OK]   $msg" -ForegroundColor Green }
function Warn  ($msg) { Write-Host "[!]    $msg" -ForegroundColor Yellow }
function Err  ($msg) { Write-Host "[ERR]  $msg" -ForegroundColor Red; exit 1 }

# ── 0. Preflight ──────────────────────────────────────────────────────────────
Log "Checking prerequisites..."

# Check OBS exists
if (-not (Test-Path $ObsPath)) {
    Warn "OBS not found at: $ObsPath"
    Warn "Trying common install paths..."
    $candidates = @(
        "C:\Program Files\obs-studio\bin\64bit\obs64.exe",
        "$env:LOCALAPPDATA\Programs\obs-studio\bin\64bit\obs64.exe",
        "${env:ProgramFiles(x86)}\obs-studio\bin\64bit\obs64.exe"
    )
    $ObsPath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $ObsPath) { Err "OBS Studio not found. Install from https://obsproject.com" }
}
Ok "OBS found: $ObsPath"

# Check dashboard is running
try {
    $resp = Invoke-WebRequest -Uri $DashboardUrl -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
    Ok "Dashboard is running at $DashboardUrl"
} catch {
    Err "Dashboard not reachable at $DashboardUrl. Run: bash scripts/start-demo.sh --skip-docker"
}

# Check output directory
if (-not (Test-Path $OutputDir)) { New-Item -ItemType Directory -Path $OutputDir | Out-Null }
$OutputPath = Join-Path $OutputDir $OutputFile
Ok "Output: $OutputPath"

# ── 1. Install obs-websocket PowerShell client if needed ──────────────────────
# We use raw WebSocket via .NET since there's no official PS module
Log "Checking for System.Net.WebSockets..."
Add-Type -AssemblyName System.Net.WebSockets.Client 2>$null
Add-Type -AssemblyName System.Threading 2>$null

# ── 2. Launch OBS minimised ───────────────────────────────────────────────────
Log "Launching OBS Studio (minimised)..."
$obsProc = Get-Process "obs64" -ErrorAction SilentlyContinue
if ($obsProc) {
    Ok "OBS already running"
} else {
    Start-Process $ObsPath -ArgumentList "--minimize-to-tray --startreplay" -WindowStyle Minimized
    Log "Waiting for OBS to initialise (10s)..."
    Start-Sleep -Seconds 10
}

# ── 3. Open Chrome/Edge to dashboard ─────────────────────────────────────────
Log "Opening dashboard in browser..."
$browser = Get-Command "chrome" -ErrorAction SilentlyContinue
if ($browser) {
    Start-Process "chrome" "--new-window --start-maximized $DashboardUrl"
} else {
    $edge = Get-Command "msedge" -ErrorAction SilentlyContinue
    if ($edge) {
        Start-Process "msedge" "--new-window --start-maximized $DashboardUrl"
    } else {
        Start-Process $DashboardUrl
    }
}
Start-Sleep -Seconds 3

# ── 4. OBS WebSocket helper functions ─────────────────────────────────────────
$ws = $null
$msgId = 1

function Connect-OBS {
    $uri = [System.Uri]"ws://localhost:$OBSPort"
    $script:ws = [System.Net.WebSockets.ClientWebSocket]::new()
    $cts = [System.Threading.CancellationTokenSource]::new([System.TimeSpan]::FromSeconds(5))
    try {
        $script:ws.ConnectAsync($uri, $cts.Token).Wait()
        Ok "Connected to OBS WebSocket"
    } catch {
        Warn "Could not connect to OBS WebSocket on port $OBSPort"
        Warn "In OBS: Tools > WebSocket Server Settings > Enable WebSocket server"
        Warn "Make sure port is $OBSPort and authentication is disabled (or set -OBSPassword)"
        return $false
    }
    # Read hello message
    $buf = [byte[]]::new(4096)
    $seg = [System.ArraySegment[byte]]$buf
    $result = $script:ws.ReceiveAsync($seg, [System.Threading.CancellationToken]::None).Result
    $hello = [System.Text.Encoding]::UTF8.GetString($buf, 0, $result.Count) | ConvertFrom-Json

    # Send Identify (no auth for simplicity)
    $identify = @{ op = 1; d = @{ rpcVersion = 1 } } | ConvertTo-Json -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($identify)
    $seg2 = [System.ArraySegment[byte]]$bytes
    $script:ws.SendAsync($seg2, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [System.Threading.CancellationToken]::None).Wait()
    Start-Sleep -Milliseconds 500
    return $true
}

function Send-OBSRequest ($requestType, $requestData = @{}) {
    $req = @{
        op = 6
        d  = @{
            requestType = $requestType
            requestId   = "$script:msgId"
            requestData = $requestData
        }
    } | ConvertTo-Json -Depth 10 -Compress
    $script:msgId++
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($req)
    $seg = [System.ArraySegment[byte]]$bytes
    $script:ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [System.Threading.CancellationToken]::None).Wait()
    Start-Sleep -Milliseconds 300

    # Read response
    $buf = [byte[]]::new(65536)
    $seg2 = [System.ArraySegment[byte]]$buf
    try {
        $result = $script:ws.ReceiveAsync($seg2, [System.Threading.CancellationToken]::None).Result
        return [System.Text.Encoding]::UTF8.GetString($buf, 0, $result.Count) | ConvertFrom-Json
    } catch { return $null }
}

function Start-Recording {
    Log "Starting OBS recording..."
    $r = Send-OBSRequest "StartRecord"
    if ($r) { Ok "Recording started" }
    else { Warn "Could not start recording via WebSocket — start manually in OBS (Ctrl+R)" }
}

function Stop-Recording {
    Log "Stopping OBS recording..."
    $r = Send-OBSRequest "StopRecord"
    if ($r) { Ok "Recording stopped. Saved to: $OutputPath" }
    else { Warn "Could not stop recording via WebSocket — stop manually in OBS (Ctrl+R)" }
}

function Set-OBSOutput {
    Log "Setting output path in OBS..."
    Send-OBSRequest "SetProfileParameter" @{
        parameterCategory = "Output"
        parameterName     = "FilePath"
        parameterValue    = $OutputDir
    } | Out-Null
    Send-OBSRequest "SetProfileParameter" @{
        parameterCategory = "Output"
        parameterName     = "RecFilePath"
        parameterValue    = $OutputDir
    } | Out-Null
}

# ── 5. Connect to OBS ─────────────────────────────────────────────────────────
$obsConnected = Connect-OBS
if ($obsConnected) { Set-OBSOutput }

# ── 6. Helper: send narration cue to console ──────────────────────────────────
function Cue ($text, $pauseSec = 0) {
    Write-Host ""
    Write-Host "  NARRATE >>> $text" -ForegroundColor Magenta
    Write-Host ""
    if ($pauseSec -gt 0) { Start-Sleep -Seconds $pauseSec }
}

# ── 7. Helper: trigger a swap via the API ─────────────────────────────────────
function Start-Swap ($task) {
    Log "Triggering swap via API..."
    try {
        $body = @{ taskDescription = $task } | ConvertTo-Json
        $resp = Invoke-RestMethod -Uri "$DashboardUrl/api/swap" `
            -Method POST `
            -Body $body `
            -ContentType "application/json" `
            -TimeoutSec 30
        Ok "Swap started — ID: $($resp.swapId)"
        return $resp.swapId
    } catch {
        Warn "Could not trigger swap via API: $_"
        Warn "Trigger it manually in the browser instead."
        return $null
    }
}

# ── 8. Run the demo ───────────────────────────────────────────────────────────
Write-Host ""
Write-Host "==========================================" -ForegroundColor White
Write-Host "  AgentSwap demo recording starting now   " -ForegroundColor White
Write-Host "==========================================" -ForegroundColor White
Write-Host ""
Write-Host "  The script will guide you with NARRATE cues." -ForegroundColor Gray
Write-Host "  Speak each cue naturally as you look at the screen." -ForegroundColor Gray
Write-Host "  Press ENTER to advance between sections." -ForegroundColor Gray
Write-Host ""
Read-Host "  Ready? Make sure OBS is recording, then press ENTER"

if ($obsConnected) { Start-Recording }

# Section 1 — Intro (0:00–0:20)
Cue "AgentSwap is a trustless cross-chain escrow protocol for AI agents." 2
Cue "A buyer agent and a seller agent negotiate, lock funds, and settle — with zero human involvement." 2
Cue "On the left: Bitcoin Lightning. On the right: Ethereum. In the middle: three Claude-powered AI agents." 3

Read-Host "  [ENTER to trigger the swap]"

# Section 2 — Trigger (0:20–0:45)
$swapId = Start-Swap "Write a haiku about trustless finance."
Cue "I'm starting a swap now. The task: write a haiku about trustless finance." 2
Cue "Watch the buyer and seller agents negotiate price in real time — structured JSON proposals, powered by Claude." 3

Log "Waiting 20s for negotiation to produce messages..."
Start-Sleep -Seconds 20

# Section 3 — Negotiation visible (0:45–1:15)
Cue "The buyer offered 60,000 sats. The seller countered. They've agreed on 75,000 sats plus 0.04 ETH." 3
Cue "Now both sides are locking funds simultaneously..." 2
Cue "The seller locks ETH into a Solidity HTLC. The buyer pays a Lightning HODL invoice." 3
Cue "Neither party can access the other's funds. The cryptographic lock is live on both chains." 3

Log "Waiting 30s for HTLCs to confirm..."
Start-Sleep -Seconds 30

# Section 4 — Locked (1:15–1:40)
Cue "Both HTLCs are now confirmed locked. You can see the chain state cards update." 2
Cue "SHA-256 of the preimage on Lightning. keccak256 of the same preimage on Ethereum." 3
Cue "The seller is now submitting the deliverable to the arbitrator..." 2

Log "Waiting 20s for arbitrator evaluation..."
Start-Sleep -Seconds 20

# Section 5 — Arbitration (1:40–2:10)
Cue "A third, independent Claude instance is now scoring the deliverable." 2
Cue "It evaluates completeness, quality, accuracy, and timeliness — against the original task spec." 3
Cue "It has no shared context with the buyer or seller. It only sees the task and the deliverable." 3

Log "Waiting 20s for settlement..."
Start-Sleep -Seconds 20

# Section 6 — Settlement (2:10–2:30)
Cue "Score: 91 out of 100. Approved. The arbitrator releases the 32-byte preimage." 2
Cue "The seller settles the Lightning invoice — BTC claimed." 2
Cue "The buyer claims the ETH HTLC using the same preimage, now public on-chain." 2
Cue "Both chains settled. Simultaneously. Trustlessly. Humans involved: zero." 3

Read-Host "  [ENTER to stop recording]"

if ($obsConnected) { Stop-Recording }

# ── 9. Done ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "==========================================" -ForegroundColor Green
Write-Host "  Recording complete!" -ForegroundColor Green
Write-Host "  File: $OutputPath" -ForegroundColor Green
Write-Host ""
Write-Host "  Next steps:" -ForegroundColor White
Write-Host "  1. Trim the recording in any video editor" -ForegroundColor Gray
Write-Host "  2. Upload to YouTube (unlisted) or Vimeo" -ForegroundColor Gray
Write-Host "  3. Paste the link in Devpost" -ForegroundColor Gray
Write-Host "==========================================" -ForegroundColor Green
Write-Host ""

if ($ws -and $ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
    $ws.CloseAsync(
        [System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure,
        "done",
        [System.Threading.CancellationToken]::None
    ).Wait()
}
