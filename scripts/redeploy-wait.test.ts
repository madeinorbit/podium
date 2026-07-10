// scripts/redeploy-wait.test.ts

import { execFileSync, spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SCRIPT = join(__dirname, 'redeploy-wait.sh')

/** Create a real git repo with an initial commit; returns the repo path. */
function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'rw-git-'))
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    })
      .toString()
      .trim()
  git('init', '-q')
  writeFileSync(join(repo, 'package.json'), '{"name":"x"}\n')
  writeFileSync(join(repo, 'bun.lock'), 'v1\n')
  writeFileSync(join(repo, 'src.ts'), '// v1\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'initial')
  return repo
}

function gitIn(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  })
    .toString()
    .trim()
}

/** A fake `bun` on PATH that records its argv (and optionally fails — everything,
 *  or just `bun run typecheck`). */
function makeFakeBun(opts: { fail?: boolean; failTypecheck?: boolean } = {}): {
  bin: string
  log: string
} {
  const dir = mkdtempSync(join(tmpdir(), 'rw-bun-'))
  const log = join(dir, 'calls.log')
  const bin = join(dir, 'bun')
  writeFileSync(
    bin,
    `#!/usr/bin/env bash\necho "$PWD :: $@" >> "${log}"\n` +
      `if [ "$1 $2" = "run typecheck" ]; then exit ${opts.fail || opts.failTypecheck ? 1 : 0}; fi\n` +
      `exit ${opts.fail ? 1 : 0}\n`,
  )
  chmodSync(bin, 0o755)
  return { bin, log }
}

function runScript(repo: string, env: Record<string, string> = {}) {
  return execFileSync('bash', [SCRIPT, repo], {
    timeout: 15_000,
    env: { ...process.env, REDEPLOY_WAIT_SETTLE: '0', ...env },
  })
}

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
    expect(waited).toBeLessThan(8000) // and returned promptly after
  })

  it('times out cleanly if the lock never clears (exit 0, bounded)', () => {
    const repo = mkdtempSync(join(tmpdir(), 'rw2-'))
    mkdirSync(join(repo, '.git'), { recursive: true })
    writeFileSync(join(repo, '.git', 'index.lock'), '')
    const t = Date.now()
    execFileSync('bash', [join(__dirname, 'redeploy-wait.sh'), repo], {
      timeout: 10_000,
      env: { ...process.env, REDEPLOY_WAIT_TIMEOUT: '2', REDEPLOY_WAIT_SETTLE: '0' },
    })
    const waited = Date.now() - t
    rmSync(repo, { recursive: true, force: true })
    // `date +%s` has 1-second granularity, so a 2s deadline can fire up to ~1s early.
    expect(waited).toBeGreaterThanOrEqual(1000)
    expect(waited).toBeLessThan(4000)
  })

  it('non-repo dir skips the dependency gate and exits 0 (legacy behavior)', () => {
    const repo = mkdtempSync(join(tmpdir(), 'rw3-'))
    mkdirSync(join(repo, '.git'), { recursive: true })
    const bun = makeFakeBun()
    runScript(repo, { REDEPLOY_BUN: bun.bin })
    expect(existsSync(bun.log)).toBe(false)
    rmSync(repo, { recursive: true, force: true })
  })

  describe('dependency install gate (#173/#176)', () => {
    it('first run (no state file) always installs + typechecks and records HEAD', () => {
      const repo = makeRepo()
      const bun = makeFakeBun()
      runScript(repo, { REDEPLOY_BUN: bun.bin })
      const calls = readFileSync(bun.log, 'utf8')
      expect(calls).toContain(`${repo} :: install --frozen-lockfile --linker=hoisted`)
      expect(calls).toContain(`${repo} :: run typecheck`)
      const state = readFileSync(join(repo, '.git', 'podium-redeploy-head'), 'utf8').trim()
      expect(state).toBe(gitIn(repo, 'rev-parse', 'HEAD'))
      rmSync(repo, { recursive: true, force: true })
    })

    it('source-only .ts change between deploys -> typecheck but NO install, state advances', () => {
      const repo = makeRepo()
      const bun = makeFakeBun()
      runScript(repo, { REDEPLOY_BUN: bun.bin }) // first run installs + records
      rmSync(bun.log, { force: true })
      writeFileSync(join(repo, 'src.ts'), '// v2\n')
      gitIn(repo, 'commit', '-qam', 'source-only change')
      runScript(repo, { REDEPLOY_BUN: bun.bin })
      const calls = readFileSync(bun.log, 'utf8')
      expect(calls).not.toContain('install --frozen-lockfile')
      expect(calls).toContain(`${repo} :: run typecheck`)
      const state = readFileSync(join(repo, '.git', 'podium-redeploy-head'), 'utf8').trim()
      expect(state).toBe(gitIn(repo, 'rev-parse', 'HEAD'))
      rmSync(repo, { recursive: true, force: true })
    })

    it('non-type-relevant change (docs only) -> bun never invoked at all (#251 cache)', () => {
      const repo = makeRepo()
      const bun = makeFakeBun()
      runScript(repo, { REDEPLOY_BUN: bun.bin }) // first run installs + records
      rmSync(bun.log, { force: true })
      writeFileSync(join(repo, 'README.md'), 'docs change\n')
      gitIn(repo, 'add', '-A')
      gitIn(repo, 'commit', '-qm', 'docs-only change')
      runScript(repo, { REDEPLOY_BUN: bun.bin })
      expect(existsSync(bun.log)).toBe(false) // neither install nor typecheck
      const state = readFileSync(join(repo, '.git', 'podium-redeploy-head'), 'utf8').trim()
      expect(state).toBe(gitIn(repo, 'rev-parse', 'HEAD'))
      rmSync(repo, { recursive: true, force: true })
    })

    it('typecheck failure -> exits non-zero and does NOT advance the deployed HEAD (#251)', () => {
      const repo = makeRepo()
      const good = makeFakeBun()
      runScript(repo, { REDEPLOY_BUN: good.bin })
      const prevHead = readFileSync(join(repo, '.git', 'podium-redeploy-head'), 'utf8').trim()
      writeFileSync(join(repo, 'src.ts'), '// v2 with a type error\n')
      gitIn(repo, 'commit', '-qam', 'broken source change')
      const bad = makeFakeBun({ failTypecheck: true })
      expect(() => runScript(repo, { REDEPLOY_BUN: bad.bin })).toThrow()
      // state untouched -> a retry after the failure typechecks again
      const state = readFileSync(join(repo, '.git', 'podium-redeploy-head'), 'utf8').trim()
      expect(state).toBe(prevHead)
      rmSync(repo, { recursive: true, force: true })
    })

    it('bun.lock change between deploys -> installs', () => {
      const repo = makeRepo()
      const bun = makeFakeBun()
      runScript(repo, { REDEPLOY_BUN: bun.bin })
      rmSync(bun.log, { force: true })
      writeFileSync(join(repo, 'bun.lock'), 'v2\n')
      gitIn(repo, 'commit', '-qam', 'lockfile change')
      runScript(repo, { REDEPLOY_BUN: bun.bin })
      expect(readFileSync(bun.log, 'utf8')).toContain('install --frozen-lockfile')
      rmSync(repo, { recursive: true, force: true })
    })

    it('nested workspace package.json change -> installs (wildcard pathspec)', () => {
      const repo = makeRepo()
      const bun = makeFakeBun()
      runScript(repo, { REDEPLOY_BUN: bun.bin })
      rmSync(bun.log, { force: true })
      mkdirSync(join(repo, 'apps', 'server'), { recursive: true })
      writeFileSync(join(repo, 'apps', 'server', 'package.json'), '{"name":"srv"}\n')
      gitIn(repo, 'add', '-A')
      gitIn(repo, 'commit', '-qm', 'add workspace manifest')
      runScript(repo, { REDEPLOY_BUN: bun.bin })
      expect(readFileSync(bun.log, 'utf8')).toContain('install --frozen-lockfile')
      rmSync(repo, { recursive: true, force: true })
    })

    it('install failure -> exits non-zero and does NOT advance the deployed HEAD', () => {
      const repo = makeRepo()
      const good = makeFakeBun()
      runScript(repo, { REDEPLOY_BUN: good.bin })
      const prevHead = readFileSync(join(repo, '.git', 'podium-redeploy-head'), 'utf8').trim()
      writeFileSync(join(repo, 'bun.lock'), 'v2\n')
      gitIn(repo, 'commit', '-qam', 'lockfile change')
      const bad = makeFakeBun({ fail: true })
      expect(() => runScript(repo, { REDEPLOY_BUN: bad.bin })).toThrow()
      // state untouched -> a retry after the failure installs again
      const state = readFileSync(join(repo, '.git', 'podium-redeploy-head'), 'utf8').trim()
      expect(state).toBe(prevHead)
      rmSync(repo, { recursive: true, force: true })
    })

    it('previous HEAD unknown to the repo (rewritten history) -> installs to be safe', () => {
      const repo = makeRepo()
      const bun = makeFakeBun()
      writeFileSync(
        join(repo, '.git', 'podium-redeploy-head'),
        'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n',
      )
      runScript(repo, { REDEPLOY_BUN: bun.bin })
      expect(readFileSync(bun.log, 'utf8')).toContain('install --frozen-lockfile')
      rmSync(repo, { recursive: true, force: true })
    })
  })
})
