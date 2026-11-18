import { execFileSync } from 'node:child_process'
import { rm } from 'node:fs/promises'
import path from 'node:path'

export async function removeUpdateFixture(root, targets) {
  for (const target of targets) {
    const relative = path.relative(root, target)
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('Expected a viewer directory inside the temporary update fixture')
    }
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
      $ErrorActionPreference = 'Stop'
      $target = [IO.Path]::Combine($env:PDF_TEST_TEMP_VIEWER, 'PDF Cross Probe.exe')
      foreach ($viewer in Get-Process -Name 'PDF Cross Probe' -ErrorAction SilentlyContinue) {
        if ($viewer.Path -ne $target) { continue }
        try {
          if (-not $viewer.HasExited) { Stop-Process -Id $viewer.Id -Force }
        } catch { if (-not $viewer.HasExited) { throw } }
        if (-not $viewer.WaitForExit(15000)) { throw 'Temporary viewer did not exit' }
      }
    `], {
      env: { ...process.env, PDF_TEST_TEMP_VIEWER: target },
      windowsHide: true, timeout: 30000,
    })
  }
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
}
