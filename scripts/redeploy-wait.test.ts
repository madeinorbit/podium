// scripts/redeploy-wait.test.ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'

describe('redeploy-wait.sh', () => {
  it('returns only after .git/index.lock clears', () => {
    const repo = mkdtempSync(join(tmpdir(), 'rw-'))
    mkdirSync(join(repo, '.git'), { recursive: true })
    const lock = join(repo, '.git', 'index.lock')
    writeFileSync(lock, '')
    // clear the lock after 600ms in the background
    const clearer = spawn('bash', ['-c', `sleep 0.6; rm -f "${lock}"`])
    const t = Date.now()
    execFileSync('bash', [join(__dirname, 'redeploy-wait.sh'), repo], { timeout: 10_000 })
    const waited = Date.now() - t
    clearer.kill()
    rmSync(repo, { recursive: true, force: true })
    expect(waited).toBeGreaterThan(500) // it waited for the lock
    expect(waited).toBeLessThan(8000)   // and returned promptly after
  })

  it('times out cleanly if the lock never clears (exit 0, bounded)', () => {
    const repo = mkdtempSync(join(tmpdir(), 'rw2-'))
    mkdirSync(join(repo, '.git'), { recursive: true })
    writeFileSync(join(repo, '.git', 'index.lock'), '')
    const t = Date.now()
    execFileSync('bash', [join(__dirname, 'redeploy-wait.sh'), repo], {
      timeout: 10_000,
      env: { ...process.env, REDEPLOY_WAIT_TIMEOUT: '2' },
    })
    const waited = Date.now() - t
    rmSync(repo, { recursive: true, force: true })
    expect(waited).toBeGreaterThanOrEqual(2000)
    expect(waited).toBeLessThan(4000)
  })
})
