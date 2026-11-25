#requires -Version 5.1
<#
  dori 一键启动：保证飞书入站消费者在跑，尽量拉起常驻 lead 面板，并给主人发一条启动消息。
  重复执行是安全的：已经在跑的部分会跳过。
#>
[CmdletBinding()]
param(
  [switch]$NoLead,      # 只起收消息的消费者，不开 lead 面板（省 token）
  [switch]$NoNotify,    # 不发启动消息
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Say([string]$Message) { if (-not $Quiet) { Write-Host $Message } }

# WinINET 的系统代理只对桌面应用生效；Bun 的 fetch 认 HTTPS_PROXY，WebSocket 只认 proxy 参数，
# 二者都不读系统代理。这里把它转成环境变量，让本脚本拉起的子进程继承。
function ConvertTo-ProxyUrl([string]$Server) {
  if (-not $Server) { return $null }
  $bare = $null; $http = $null; $https = $null
  foreach ($part in $Server.Split(';')) {
    $pair = $part.Split('=', 2)
    if ($pair.Count -eq 2) {
      switch ($pair[0].Trim().ToLowerInvariant()) {
        'https' { $https = $pair[1].Trim() }
        'http'  { $http = $pair[1].Trim() }
      }
    } elseif ($part.Trim()) {
      $bare = $part.Trim()
    }
  }
  $chosen = if ($https) { $https } elseif ($http) { $http } else { $bare }
  if (-not $chosen) { return $null }
  if ($chosen -notmatch '^[a-zA-Z][a-zA-Z0-9+.-]*://') { $chosen = "http://$chosen" }
  return $chosen
}

function Get-SystemProxyUrl {
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
  $settings = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
  if (-not $settings) { return $null }
  if (-not ($settings.PSObject.Properties.Name -contains 'ProxyEnable')) { return $null }
  if (-not $settings.ProxyEnable) { return $null }
  if (-not ($settings.PSObject.Properties.Name -contains 'ProxyServer')) { return $null }
  return ConvertTo-ProxyUrl ([string]$settings.ProxyServer)
}

$proxyUrl = $null
if ($env:HTTPS_PROXY) { $proxyUrl = $env:HTTPS_PROXY }
elseif ($env:https_proxy) { $proxyUrl = $env:https_proxy }
elseif ($env:ALL_PROXY) { $proxyUrl = $env:ALL_PROXY }
elseif ($env:all_proxy) { $proxyUrl = $env:all_proxy }
else {
  $proxyUrl = Get-SystemProxyUrl
  if ($proxyUrl) { $env:HTTPS_PROXY = $proxyUrl }
}

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$stateDir = Join-Path $HOME '.dori'
$logDir = Join-Path $stateDir 'logs'
$configFile = Join-Path $stateDir 'config.json'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$bun = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bun) { Write-Error 'bun 不在 PATH 上，先安装 bun (https://bun.sh)'; exit 1 }
$bunPath = $bun.Source
$omo = Get-Command omo -ErrorAction SilentlyContinue
# 面板的 PATH 不一定有 omo（herdr server 的环境可能更旧），所以用绝对路径。
$omoPath = if ($omo) { $omo.Source } else { 'omo' }
$cli = Join-Path $root 'skills\dori-mode\scripts\src\cli.ts'
if (-not (Test-Path $cli)) { Write-Error "找不到 dori CLI：$cli"; exit 1 }

$config = $null
if (Test-Path $configFile) { $config = Get-Content $configFile -Raw | ConvertFrom-Json }
$chatId = ''
$model = 'muskapi/claude-opus-5-5'
if ($config) {
  if ($config.PSObject.Properties.Name -contains 'feishu' -and $config.feishu) { $chatId = [string]$config.feishu.chatId }
  if ($config.PSObject.Properties.Name -contains 'defaultModel' -and $config.defaultModel) { $model = [string]$config.defaultModel }
}

$discordTokenFile = Join-Path $stateDir 'discord-token'
$discordOwnerFile = Join-Path $stateDir 'discord-owner'
$discordLog = Join-Path $logDir 'discord.log'
$discordEnabled = (Test-Path $discordTokenFile) -and (Test-Path $discordOwnerFile)

Say '== dori 启动 =='
Say "仓库   $root"
Say "Bun    $bunPath"
if ($proxyUrl) { Say "代理   $proxyUrl" } else { Say '代理   无（直连）' }

# 1. herdr：只在自己没起时启无头 server（有 TUI 在跑就不碰，避免抢会话）
$herdr = Get-Command herdr -ErrorAction SilentlyContinue
$herdrUp = $false
if ($herdr) {
  $status = (& herdr status 2>$null) -join "`n"
  $herdrUp = $status -match 'status:\s*running'
  if (-not $herdrUp) {
    Say 'herdr server 未运行，以无头方式启动 ...'
    Start-Process -FilePath $herdr.Source -ArgumentList 'server' -WindowStyle Hidden | Out-Null
    for ($i = 0; $i -lt 20; $i++) {
      Start-Sleep -Milliseconds 500
      if (((& herdr status 2>$null) -join "`n") -match 'status:\s*running') { $herdrUp = $true; break }
    }
    if (-not $herdrUp) { Say 'WARN herdr server 10 秒内未就绪，跳过 lead' }
  }
} else {
  Say 'WARN herdr 不在 PATH 上，跳过 lead'
}

# 2. 飞书入站消费者（幂等；父进程被强杀时 lark-cli 会变孤儿，先回收）
$running = @(Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*cli.ts*inbound*feishu*' })
if ($running.Count -gt 0) {
  Say "飞书消费者已在运行 (pid $($running[0].ProcessId))"
} else {
  $orphans = @(Get-CimInstance Win32_Process |
    Where-Object { $_.Name -eq 'lark-cli.exe' -and $_.CommandLine -like '*event*consume*' })
  foreach ($o in $orphans) {
    Say "回收孤儿 lark-cli (pid $($o.ProcessId))"
    Stop-Process -Id $o.ProcessId -Force -ErrorAction SilentlyContinue
  }
  if ($orphans.Count -gt 0) { Start-Sleep -Seconds 1 }

  $log = Join-Path $logDir 'inbound.log'
  if (Test-Path $log) { Move-Item -Force $log (Join-Path $logDir ("inbound.{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))) }
  Start-Process -FilePath $bunPath `
    -ArgumentList @($cli, 'inbound', 'feishu', '--loop', '1') `
    -WindowStyle Hidden `
    -RedirectStandardOutput $log `
    -RedirectStandardError (Join-Path $logDir 'inbound.err.log') | Out-Null
  Say "飞书消费者已启动，日志 $log"
}

# 2b. Discord 入站消费者（凭据在 ~/.dori/discord-token 与 discord-owner；缺失则跳过）
if ($discordEnabled) {
  $discordRunning = @(Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*cli.ts*inbound*discord*' })
  if ($discordRunning.Count -gt 0) {
    Say "Discord 消费者已在运行 (pid $($discordRunning[0].ProcessId))"
  } else {
    $env:DORI_DISCORD_TOKEN = (Get-Content $discordTokenFile -Raw).Trim()
    $env:DORI_DISCORD_OWNER_ID = (Get-Content $discordOwnerFile -Raw).Trim()
    if (Test-Path $discordLog) { Move-Item -Force $discordLog (Join-Path $logDir ("discord.{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))) }
    Start-Process -FilePath $bunPath `
      -ArgumentList @($cli, 'inbound', 'discord', '--loop', '1') `
      -WindowStyle Hidden `
      -RedirectStandardOutput $discordLog `
      -RedirectStandardError (Join-Path $logDir 'discord.err.log') | Out-Null
    Say "Discord 消费者已启动，日志 $discordLog"
  }
} else {
  Say 'Discord 未配置（缺 ~/.dori/discord-token 或 discord-owner），跳过'
}

# 3. 常驻 lead：一个跑 omo 的 herdr 面板，读 INBOUND 并回复
if (-not $NoLead -and $herdrUp) {
  $leadFile = Join-Path $stateDir 'lead.md'
  $discordBrief = ''
  if ($discordEnabled) {
    $discordBrief = @"

## Discord（同一主人的另一个渠道）
- 入站日志：$discordLog，同样只上报以 INBOUND 开头的行，格式 "INBOUND discord <channel> <message_id> <author_id> ..."。
- 每条先回执再回复：
  "$bunPath" "$cli" react discord --to <channel> --message <message_id>
  "$bunPath" "$cli" send discord --to <channel> --text "回复内容"
- 需要独立线程时：
  "$bunPath" "$cli" thread start --to <channel> --message <message_id> --name "[working] <标题>"
  再用返回的 THREAD id 当作 --to 发送；完成时 thread rename 改成 [done] 并 thread archive。
"@
  }
  $lead = @"
# dori 常驻值守

你是 dori，这台 Windows 机器上的常驻管家。启动脚本刚把你拉起，现在开始值守。

## 值守
1. 立刻挂一个常驻 monitor 盯住 $logDir\inbound.log，只上报以 INBOUND 开头的行。若存在 Discord 渠道，再挂一个盯 $discordLog。
2. 每收到一条，只在 INBOUND 行标明的平台回复，绝不用另一个渠道回。
   飞书（INBOUND feishu <chat> <message_id> ...）：
   "$bunPath" "$cli" react feishu --message <message_id> --emoji Typing
   "$bunPath" "$cli" send feishu --to <chat> --thread <message_id> --text "回复内容"
3. 启动 lane 时把来源写进 --thread：feishu:<chat>:<message_id>、discord:<channel> 或 discord-thread:<thread_id>。
   freshness 与 close 的通知用 dori reply / dori finish 按这个引用回到来源渠道，不要写死飞书。
4. 没有消息时保持安静：不主动开工、不轮询、不自己找活干。
$discordBrief

## 改代码
- 在任务分支上做，完成后 dori pr open <key> --branch <branch> --base main。
- 把 PR 摘要发回请求来源的那个渠道（飞书或 Discord），等主人明确同意后再 dori pr approve 与 dori land。
- 绝不自己合入主分支。
"@
  Set-Content -Path $leadFile -Value $lead -Encoding UTF8

  $tabs = (& herdr workspace list 2>$null | ConvertFrom-Json).result.workspaces
  $paneId = ''
  $ws = @($tabs) | Where-Object { $_.label -eq 'dori' } | Select-Object -First 1
  if ($ws) {
    $pane = @((& herdr pane list 2>$null | ConvertFrom-Json).result.panes) |
      Where-Object { $_.workspace_id -eq $ws.workspace_id } | Select-Object -First 1
    if ($pane) { $paneId = [string]$pane.pane_id }
  }
  if (-not $paneId) {
    $created = & herdr workspace create --label dori --cwd $root --no-focus 2>$null | ConvertFrom-Json
    $paneId = [string]$created.result.root_pane.pane_id
    Say "已开工作区 dori（面板 $paneId）"
  }

  $target = @((& herdr pane list 2>$null | ConvertFrom-Json).result.panes) |
    Where-Object { $_.pane_id -eq $paneId } | Select-Object -First 1
  $hasOmo = $false
  if ($target -and ($target.PSObject.Properties.Name -contains 'tokens') -and $target.tokens) {
    $hasOmo = ($target.tokens.app -eq 'omo')
  }
  if ($hasOmo) {
    Say "lead 已在运行 ($paneId)"
  } else {
    # pane run 会一直等到被敲进去的命令退出；omo 不退出，脚本就卡死。
    $omoLine = $omoPath + ' --model ' + $model + ' read ' + $leadFile + ' and follow it'
    & herdr pane send-text $paneId $omoLine | Out-Null
    & herdr pane send-keys $paneId enter | Out-Null
    Say "lead 已拉起 ($paneId)"
  }
}

# 4. 启动消息
if (-not $NoNotify) {
  if (-not $chatId) {
    Say 'WARN 配置里没有 feishu.chatId，跳过启动消息'
  } else {
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $text = "dori 已启动（$env:COMPUTERNAME，$stamp），入站监听已就绪。有需求直接发消息。"
    $sent = & $bunPath $cli send feishu --to $chatId --text $text 2>&1
    Say "启动消息：$sent"
    Add-Content -Path (Join-Path $logDir 'startup.log') -Value "$stamp $sent" -Encoding UTF8
  }
}

Say '== 完成 =='
