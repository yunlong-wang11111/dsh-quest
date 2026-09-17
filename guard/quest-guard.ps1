# quest-guard.ps1 —— quest 服务的最小监督器（Windows / 计划任务）
#
# 为什么需要它：quest 是个服务，**服务无法监督自己**。任务本身能扛住 quest 崩溃
# （句柄直挂 / systemd 认养 / 重启后认领），但 quest 进程死了就没人再判定和通知——
# 得有个外部东西把它拉起来。Windows 上没有 systemd，这就是那个东西。
#
# 注册为每 5 分钟执行一次的计划任务：
#   schtasks /Create /TN "quest-guard" /SC MINUTE /MO 5 /RL HIGHEST ^
#            /TR "powershell -NoProfile -ExecutionPolicy Bypass -File C:\path\to\quest-guard.ps1" /F
#
# 参数（也可用环境变量）：
#   -Url       quest 服务地址，默认 http://127.0.0.1:3110
#   -QuestDir  quest 源码目录（含 server.mjs）
#   -LogFile   日志路径，默认 <QuestDir>\guard.log
#   -TokenFile quest 令牌文件，默认 <用户目录>\.dsh\quests\.token
param(
  [string]$Url = $(if ($env:QUEST_URL) { $env:QUEST_URL } else { 'http://127.0.0.1:3110' }),
  [string]$QuestDir = $(if ($env:QUEST_DIR) { $env:QUEST_DIR } else { '.' }),
  [string]$LogFile = '',
  [string]$TokenFile = $(if ($env:QUEST_HOME) { Join-Path $env:QUEST_HOME '.token' } else { Join-Path $env:USERPROFILE '.dsh\quests\.token' })
)
$ErrorActionPreference = 'SilentlyContinue'
if (-not $LogFile) { $LogFile = Join-Path $QuestDir 'guard.log' }
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
function Log($m) { Add-Content -Path $LogFile -Value "$stamp $m" -Encoding UTF8 }

$curl = "$env:SystemRoot\System32\curl.exe"

# 1) 探活：任何 HTTP 响应（含 401）都算活着；000 才是真死
$token = ''
try { $token = (Get-Content $TokenFile -Raw).Trim() } catch {}
$code = & $curl -sS -m 6 -o NUL -w '%{http_code}' -H "x-quest-token: $token" "$Url/api/status" 2>$null
if ($code -and $code -ne '000') {
  Log "OK: quest alive (HTTP $code)"
  exit 0
}

# 2) 挂了：拉起来（脱离当前会话，输出追加到服务日志）
Log "DOWN: quest unreachable (HTTP $code) — restarting"
$server = Join-Path $QuestDir 'server.mjs'
if (-not (Test-Path $server)) { Log "FAIL: $server 不存在，检查 -QuestDir"; exit 1 }
$out = Join-Path $QuestDir 'quest-stdout.log'
$err = Join-Path $QuestDir 'quest-stderr.log'
Start-Process -FilePath 'node' -ArgumentList $server -WorkingDirectory $QuestDir -WindowStyle Hidden `
  -RedirectStandardOutput $out -RedirectStandardError $err

# 3) 等它就绪（最多 20 秒）
$ok = '000'
for ($i = 0; $i -lt 10; $i++) {
  Start-Sleep -Seconds 2
  $ok = & $curl -sS -m 4 -o NUL -w '%{http_code}' -H "x-quest-token: $token" "$Url/api/status" 2>$null
  if ($ok -and $ok -ne '000') { break }
}
Log "RESTART: quest restarted, status=$ok"
exit 0
