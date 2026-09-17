# ============================================
# 从百度云服务器拉回采集生成的题库（在本机 Windows 执行）
# 用法:  powershell -File sync-back.ps1 -Server root@1.2.3.4
# 依赖:  Windows 10+ 自带 OpenSSH scp.exe（或安装 rsync 亦可）
# ============================================
param(
  [Parameter(Mandatory = $true)]
  [string]$Server,                        # 例: root@服务器IP
  [string]$RemoteDir = '/opt/kaogong',    # 服务器采集目录
  [string]$LocalDir  = (Split-Path -Parent $PSScriptRoot)  # 默认拉回仓库根目录
)

$dbs = @('tiku.db', 'practice.db', 'materials.db')

foreach ($db in $dbs) {
  $remote = "$Server`:$RemoteDir/$db"
  $local  = Join-Path $LocalDir $db
  Write-Host "[scp] $remote -> $local"
  & scp -p $remote $local
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "拉取 $db 失败（exit=$LASTEXITCODE），服务器上可能还没跑出该文件"
  }
}

Write-Host ""
Write-Host "完成。已解压/重启服务前请确认 db 文件未被占用。"
Write-Host "重新打包手机版内置题库:  node build-ai-agents.mjs（见 BUILD_MANUAL.md）"