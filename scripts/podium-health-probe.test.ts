// scripts/podium-health-probe.test.ts
//
// Drives podium-health-probe.sh with fake `systemctl`/`curl`/`sleep` binaries on
// PATH (same pattern as redeploy-wait.test.ts). Each fake reads a per-call
// "script" file from the fixture dir — one line per invocation, last line
// repeated — so tests can express state that CHANGES between the two probes
// (e.g. the server getting restarted while the probe sleeps).

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const SCRIPT = join(__dirname, 'podium-health-probe.sh')

/** ISO timestamp `secondsAgo` seconds in the past — `date -d` parses ISO 8601. */
function ago(secondsAgo: number): string {
  return new Date(Date.now() - secondsAgo * 1000).toISOString()
}

interface Fixture {
  dir: string
  /** newline log of every fake-binary invocation, in order */
  log(): string
  restarts(): string[]
  curlCalls(): number
  run(env?: Record<string, string>): void
}

const fixtures: string[] = []
afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * Build a fixture dir with fake binaries. `states` / `timestamps` / `curlExits`
 * are per-call sequences (last entry repeated once exhausted).
 */
function makeFixture(opts: {
  states: string[]
  timestamps: string[]
  curlExits: number[]
}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'hp-'))
  fixtures.push(dir)
  writeFileSync(join(dir, 'state.seq'), opts.states.join('\n') + '\n')
  writeFileSync(join(dir, 'ts.seq'), opts.timestamps.join('\n') + '\n')
  writeFileSync(join(dir, 'curl.seq'), opts.curlExits.join('\n') + '\n')

  // Shared sequencer: prints the Nth line of $1 (counter in $1.n), repeating
  // the last line once the sequence is exhausted.
  const nextLine = `next_line() {
  local n=0
  [ -f "$1.n" ] && n=$(cat "$1.n")
  n=$((n+1)); echo "$n" > "$1.n"
  local total; total=$(wc -l < "$1")
  [ "$n" -gt "$total" ] && n=$total
  sed -n "\${n}p" "$1"
}`

  const bin = (name: string, body: string) => {
    const p = join(dir, name)
    writeFileSync(p, `#!/usr/bin/env bash\nFD="${dir}"\n${nextLine}\n${body}\n`)
    chmodSync(p, 0o755)
  }

  bin(
    'systemctl',
    `echo "systemctl $@" >> "$FD/calls.log"
case "$*" in
  *ActiveState*) next_line "$FD/state.seq" ;;
  *ActiveEnterTimestamp*) next_line "$FD/ts.seq" ;;
  *restart*) echo "$@" >> "$FD/restarts.log" ;;
esac
exit 0`,
  )
  bin(
    'curl',
    `echo "curl $@" >> "$FD/calls.log"
exit "$(next_line "$FD/curl.seq")"`,
  )
  bin('sleep', `echo "sleep $@" >> "$FD/calls.log"\nexit 0`)

  return {
    dir,
    log: () => (existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8') : ''),
    restarts: () =>
      existsSync(join(dir, 'restarts.log'))
        ? readFileSync(join(dir, 'restarts.log'), 'utf8').trim().split('\n')
        : [],
    curlCalls() {
      return this.log()
        .split('\n')
        .filter((l: string) => l.startsWith('curl ')).length
    },
    run(env: Record<string, string> = {}) {
      execFileSync('bash', [SCRIPT], {
        timeout: 15_000,
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          PODIUM_HEALTH_GRACE: '120',
          PODIUM_HEALTH_RETRY_SLEEP: '0', // fake sleep anyway; keep it explicit
          ...env,
        },
      })
    },
  }
}

const OLD = ago(600) // active well past the 120s grace

describe('podium-health-probe.sh', () => {
  it('(a) inactive server -> exits 0, no restart, no curl', () => {
    const f = makeFixture({ states: ['inactive'], timestamps: [OLD], curlExits: [1] })
    f.run()
    expect(f.restarts()).toEqual([])
    expect(f.curlCalls()).toBe(0)
  })

  it('(b) fresh boot within grace -> exits 0, no restart, no curl', () => {
    const f = makeFixture({ states: ['active'], timestamps: [ago(10)], curlExits: [1] })
    f.run()
    expect(f.restarts()).toEqual([])
    expect(f.curlCalls()).toBe(0)
  })

  it('(c) healthy curl -> exits 0, single probe, no restart', () => {
    const f = makeFixture({ states: ['active'], timestamps: [OLD], curlExits: [0] })
    f.run()
    expect(f.restarts()).toEqual([])
    expect(f.curlCalls()).toBe(1)
  })

  it('(d) first curl fails, second succeeds -> no restart', () => {
    const f = makeFixture({ states: ['active'], timestamps: [OLD], curlExits: [1, 0] })
    f.run()
    expect(f.restarts()).toEqual([])
    expect(f.curlCalls()).toBe(2)
    expect(f.log()).toContain('sleep 0') // second chance actually waited
  })

  it('(e) both probes fail -> restart invoked exactly once', () => {
    const f = makeFixture({ states: ['active'], timestamps: [OLD], curlExits: [1, 1] })
    f.run()
    expect(f.restarts()).toEqual(['--user restart podium-server.service'])
    expect(f.curlCalls()).toBe(2)
  })

  it('(f) server restarted between the two probes (timestamp moves into grace) -> no restart', () => {
    const f = makeFixture({
      states: ['active', 'active'],
      timestamps: [OLD, ago(5)], // restarted while the probe slept
      curlExits: [1, 1], // even though curl would keep failing
    })
    f.run()
    expect(f.restarts()).toEqual([])
    expect(f.curlCalls()).toBe(1) // second probe never fired
  })

  it('empty/unparseable ActiveEnterTimestamp -> exits 0, no restart', () => {
    const f = makeFixture({ states: ['active'], timestamps: ['n/a'], curlExits: [1] })
    f.run()
    expect(f.restarts()).toEqual([])
    expect(f.curlCalls()).toBe(0)
  })

  it('curl probes the PODIUM_PORT /health URL with -m timeout', () => {
    const f = makeFixture({ states: ['active'], timestamps: [OLD], curlExits: [0] })
    f.run({ PODIUM_PORT: '19999' })
    expect(f.log()).toContain('curl -fsS -m 10 http://localhost:19999/health')
  })

  it('(f-inactive) server mid-restart at the second check -> no restart', () => {
    const f = makeFixture({
      states: ['active', 'activating'],
      timestamps: [OLD],
      curlExits: [1, 1],
    })
    f.run()
    expect(f.restarts()).toEqual([])
    expect(f.curlCalls()).toBe(1)
  })
})
