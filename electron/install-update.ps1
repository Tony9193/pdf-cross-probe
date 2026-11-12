param([Parameter(Mandatory = $true)][string]$TransactionFile)
$ErrorActionPreference = 'Stop'
$transaction = [IO.File]::ReadAllText($TransactionFile, [Text.Encoding]::UTF8) | ConvertFrom-Json
$target = [IO.Path]::GetFullPath($transaction.target)
$stage = [IO.Path]::GetFullPath($transaction.stage)
$parent = [IO.Path]::GetDirectoryName($target)
$work = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($TransactionFile))
if ($transaction.schema -ne 1 -or $transaction.token -notmatch '^[a-f0-9-]{36}$' -or
    $target -eq [IO.Path]::GetPathRoot($target) -or
    [IO.Path]::GetDirectoryName($stage) -ne $parent -or
    [IO.Path]::GetFileName($stage) -notlike '.pdf-update-*' -or
    $transaction.backup -ne "$target.backup-$($transaction.token)" -or
    $transaction.failed -ne "$target.failed-$($transaction.token)" -or
    $transaction.health -ne [IO.Path]::Combine($work, 'healthy.json') -or
    $transaction.status -ne [IO.Path]::Combine($work, 'result.json')) { throw 'Invalid update transaction' }

$encoding = New-Object Text.UTF8Encoding($false)
$child = $null
$healthy = $false

function Write-State([string]$phase, [string]$message = '') {
  $result = @{ phase = $phase; token = $transaction.token; version = $transaction.version; message = $message }
  if ($child) { $result.pid = $child.Id }
  [IO.File]::WriteAllText($transaction.status, ($result | ConvertTo-Json -Compress), $encoding)
}

function Move-Directory([string]$source, [string]$destination) {
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    try { [IO.Directory]::Move($source, $destination); return }
    catch { if ($attempt -eq 39) { throw }; [Threading.Thread]::Sleep(250) }
  }
}

function Start-Viewer([bool]$checkHealth) {
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = [IO.Path]::Combine($target, 'PDF Cross Probe.exe')
  $info.WorkingDirectory = $target
  $info.UseShellExecute = $false
  $info.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE')
  $arguments = "--user-data-dir=`"$($transaction.userData)`""
  if ($checkHealth) { $arguments += " --update-health=`"$($transaction.health)`" --update-token=$($transaction.token)" }
  $info.Arguments = $arguments
  return [Diagnostics.Process]::Start($info)
}

function Preserve-LocalFiles([string]$directory, [string]$relative = '') {
  foreach ($item in Get-ChildItem -LiteralPath $directory -Force) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Portable directory contains a link' }
    $name = if ($relative) { "$relative/$($item.Name)" } else { $item.Name }
    if ($item.PSIsContainer) { Preserve-LocalFiles $item.FullName $name }
    elseif ($transaction.files -notcontains $name) {
      $destination = [IO.Path]::Combine($stage, $name.Replace('/', [IO.Path]::DirectorySeparatorChar))
      [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
      [IO.File]::Copy($item.FullName, $destination, $false)
    }
  }
}

try {
  if (Test-Path -LiteralPath $transaction.backup) {
    $prior = $null
    try { $prior = [IO.File]::ReadAllText($transaction.status, [Text.Encoding]::UTF8) | ConvertFrom-Json } catch {}
    if ($prior.phase -eq 'installed') { exit 0 }
    if (Test-Path -LiteralPath $target) { Move-Directory $target $transaction.failed }
    Move-Directory $transaction.backup $target
    $child = Start-Viewer $false
    Write-State 'rolled-back' 'Interrupted update restored from transaction backup'
    exit 0
  }
  Write-State 'waiting'
  if ($transaction.oldPid -gt 0) {
    $old = Get-Process -Id $transaction.oldPid -ErrorAction SilentlyContinue
    if ($old -and -not $old.WaitForExit(60000)) { throw 'Old application did not exit' }
  }
  Preserve-LocalFiles $target
  Write-State 'backing-up'
  Move-Directory $target $transaction.backup
  Write-State 'backed-up'
  Move-Directory $stage $target
  Write-State 'starting'
  $child = Start-Viewer $true
  $deadline = [DateTime]::UtcNow.AddSeconds(45)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-Path -LiteralPath $transaction.health) {
      try {
        $health = [IO.File]::ReadAllText($transaction.health, [Text.Encoding]::UTF8) | ConvertFrom-Json
        if ($health.token -eq $transaction.token -and $health.version -eq $transaction.version) { $healthy = $true; break }
      } catch {}
    }
    if ($child.HasExited) { break }
    [Threading.Thread]::Sleep(100)
  }
  if (-not $healthy) { throw 'New application did not become ready' }
  Write-State 'installed'
  try { Remove-Item -LiteralPath $transaction.backup -Recurse -Force } catch {}
  try { Remove-Item -LiteralPath ([IO.Path]::Combine($work, 'update.zip')) -Force -ErrorAction SilentlyContinue } catch {}
} catch {
  if ($child -and -not $child.HasExited) {
    try { $child.Kill(); $child.WaitForExit(10000) | Out-Null } catch {}
  }
  try {
    if (Test-Path -LiteralPath $transaction.backup) {
      if (Test-Path -LiteralPath $target) { Move-Directory $target $transaction.failed }
      Move-Directory $transaction.backup $target
    }
    if (Test-Path -LiteralPath ([IO.Path]::Combine($target, 'PDF Cross Probe.exe'))) { $child = Start-Viewer $false }
    Write-State 'rolled-back' 'Update failed; old application restored'
    if (Test-Path -LiteralPath $transaction.failed) { Remove-Item -LiteralPath $transaction.failed -Recurse -Force }
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
  } catch { Write-State 'recovery-needed' 'Restore the preserved backup directory before retrying' }
}