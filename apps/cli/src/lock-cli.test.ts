import { describe, expect, it, vi } from 'vitest'
import {
  EXIT_INTERRUPTED,
  EXIT_QUEUED,
  EXIT_WAIT_TIMEOUT,
  fmtDuration,
  mergeLockArgv,
  parseLockArgs,
  runLockCli,
  sleepUnlessAborted,
} from './lock-cli'

/**
 * `podium lock` / `podium merge-lock` CLI dispatch [spec:SP-85d1] —
 * mocked-client style (see issue-cli.test.ts): parse, positional mapping, the
 * merge:<branch> name mapping, exit-code contract (0 granted · 3 queued ·
 * 4 wait-timeout · 130 interrupted), and the --wait poll loop — which after
 * POD-612 blocks until granted with no default deadline, and hands the queue
 * place back on every way out of the wait (--timeout, SIGINT/SIGTERM), because
 * the waiter row belongs to the agent session and outlives this process.
 */

const grantedWire = (name: string) => ({
  granted: true,
  alreadyHeld: false,
  lock: {
    repoId: 'r',
    name,
    holder: {
      sessionId: 's1',
      issueId: null,
      label: 'session:s1',
      alive: true,
      workspace: '/wt/a',
    },
    note: null,
    acquiredAt: 'now',
    expiresAt: 'later',
    secondsLeft: 600,
    queue: [],
  },
})

const queuedWire = (name: string, position: number) => ({
  granted: false,
  position,
  lock: {
    ...grantedWire(name).lock,
    holder: {
      sessionId: 's2',
      issueId: 'iss_2',
      label: 'issue:#2',
      alive: true,
      workspace: '/wt/b',
    },
    queue: [
      {
        position: 1,
        sessionId: 's3',
        issueId: 'iss_3',
        label: 'issue:#3',
        enqueuedAt: '2026-08-07T09:12:52.000Z',
        alive: false,
        workspace: null,
      },
    ],
  },
})

describe('parseLockArgs', () => {
  it('parses command, positionals, flags, and bool flags (--wait takes no value)', () => {
    const r = parseLockArgs(['acquire', 'merge:main', '--ttl', '10m', '--wait', '--timeout', '30'])
    expect(r.command).toBe('acquire')
    expect(r.positionals).toEqual(['merge:main'])
    expect(r.args).toMatchObject({ ttl: '10m', wait: true, timeout: '30' })
  })

  it('accepts a human --timeout the same way --ttl is spelled', () => {
    const r = parseLockArgs(['acquire', 'l', '--wait', '--timeout', '45m'])
    expect(r.args).toMatchObject({ wait: true, timeout: '45m' })
  })
})

describe('sleepUnlessAborted', () => {
  it('resolves at once for a signal that is already spent', async () => {
    const controller = new AbortController()
    controller.abort()
    // A ten-minute nap: only the aborted check can make this return.
    const start = Date.now()
    await sleepUnlessAborted(600_000, controller.signal)
    expect(Date.now() - start).toBeLessThan(1_000)
  })

  it('resolves for a signal that goes aborted as the listener is registered', async () => {
    // An AbortSignal never replays `abort` to a listener added afterwards, so
    // without the post-registration re-check this sleeps the full ten minutes.
    let aborted = false
    const spent = {
      get aborted() {
        return aborted
      },
      addEventListener: () => {
        aborted = true
      },
      removeEventListener: () => {},
    } as unknown as AbortSignal
    const start = Date.now()
    await sleepUnlessAborted(600_000, spent)
    expect(Date.now() - start).toBeLessThan(1_000)
  })

  it('still sleeps normally when nothing aborts', async () => {
    const controller = new AbortController()
    const start = Date.now()
    await sleepUnlessAborted(5, controller.signal)
    expect(Date.now() - start).toBeGreaterThanOrEqual(4)
  })
})

describe('fmtDuration', () => {
  it('spells seconds the way the wait messages quote them back', () => {
    expect(fmtDuration(45)).toBe('45s')
    expect(fmtDuration(90)).toBe('1m30s')
    expect(fmtDuration(1800)).toBe('30m')
    expect(fmtDuration(7200)).toBe('2h')
    expect(fmtDuration(9999)).toBe('2h46m39s')
  })
})

describe('mergeLockArgv', () => {
  it('maps verbs onto merge:<branch> with main as the default', () => {
    expect(mergeLockArgv(['acquire', '--wait'])).toEqual(['acquire', 'merge:main', '--wait'])
    expect(mergeLockArgv(['release'])).toEqual(['release', 'merge:main'])
    expect(mergeLockArgv(['status', '--branch', 'develop'])).toEqual(['status', 'merge:develop'])
    expect(mergeLockArgv(['steal', '--branch=rel/1.0', '--note', 'stuck'])).toEqual([
      'steal',
      'merge:rel/1.0',
      '--note',
      'stuck',
    ])
  })

  it('passes help through and rejects a valueless --branch', () => {
    expect(mergeLockArgv(['help'])).toEqual(['help'])
    expect(() => mergeLockArgv(['acquire', '--branch'])).toThrow(/--branch needs a value/)
  })

  it('collapses the refs/heads spelling onto the same lease (POD-672)', () => {
    // Two spellings of one branch must not become two mutexes.
    expect(mergeLockArgv(['acquire', '--branch', 'refs/heads/main'])).toEqual([
      'acquire',
      'merge:main',
    ])
  })
})

describe('lock name validation reaches the CLI', () => {
  it('refuses the bare `merge` before the round trip, naming the canonical lock', async () => {
    // POD-672: this name used to be accepted as an independent lease, so an
    // agent taking `merge` serialised against nobody holding `merge:main`.
    const mutate = vi.fn()
    const client = { lock: { acquire: { mutate } } } as never
    // The error carries the canonical name, so an agent reading it does not
    // have to go hunting for the right spelling.
    await expect(runLockCli(['acquire', 'merge', '--repoPath', '/r'], client)).rejects.toThrow(
      /merge:main/,
    )
    expect(mutate).not.toHaveBeenCalled()
  })
})

describe('runLockCli', () => {
  it('acquire granted → exit 0 with the grant text', async () => {
    const mutate = vi.fn(async () => grantedWire('merge:main'))
    const client = { lock: { acquire: { mutate } } } as never
    const out = await runLockCli(['acquire', 'merge:main', '--repoPath', '/r'], client)
    expect(out.exitCode).toBe(0)
    expect(out.text).toContain("acquired 'merge:main'")
    expect(mutate).toHaveBeenCalledWith({ repoPath: '/r', name: 'merge:main' })
  })

  it('acquire queued → distinct non-zero exit so scripts can branch', async () => {
    const client = {
      lock: { acquire: { mutate: vi.fn(async () => queuedWire('l', 2)) } },
    } as never
    const out = await runLockCli(['acquire', 'l', '--repoPath', '/r'], client)
    expect(out.exitCode).toBe(EXIT_QUEUED)
    expect(out.text).toContain('position 2')
    // Acquire-time text names the holder's session so the agent can address them.
    expect(out.text).toContain('s2 on issue:#2 workspace /wt/b [alive]')
  })

  it('status prints session id, workspace, and liveness per holder and queue row', async () => {
    const lock = {
      ...queuedWire('test:heavy', 1).lock,
      name: 'test:heavy',
      holder: {
        sessionId: '3a61f07a-holder',
        issueId: 'iss_527',
        label: 'issue:#527',
        alive: true,
        workspace: '/repo/.worktrees/issue-527',
      },
      queue: [
        {
          position: 1,
          sessionId: 'sess-516-a',
          issueId: 'iss_516',
          label: 'issue:#516',
          enqueuedAt: '2026-08-07T09:12:52.000Z',
          alive: true,
          workspace: '/repo/.worktrees/issue-516',
        },
        {
          position: 2,
          sessionId: 'sess-516-ghost',
          issueId: 'iss_516',
          label: 'issue:#516',
          enqueuedAt: '2026-08-07T09:15:00.000Z',
          alive: false,
          workspace: null,
        },
      ],
      acquiredAt: '2026-08-07T09:00:00.000Z',
      secondsLeft: 1635,
    }
    const client = {
      lock: { status: { query: vi.fn(async () => [lock]) } },
    } as never
    const out = await runLockCli(['status', 'test:heavy', '--repoPath', '/r'], client)
    expect(out.exitCode).toBe(0)
    expect(out.text).toContain(
      'held by 3a61f07a-holder on issue:#527 workspace /repo/.worktrees/issue-527 [alive]',
    )
    expect(out.text).toContain(
      '1. sess-516-a on issue:#516 workspace /repo/.worktrees/issue-516 [alive]',
    )
    expect(out.text).toContain('2. sess-516-ghost on issue:#516 [dead]')
  })

  it('acquire --allow-sibling rides through to the proc', async () => {
    const mutate = vi.fn(async () => grantedWire('l'))
    const client = { lock: { acquire: { mutate } } } as never
    await runLockCli(['acquire', 'l', '--repoPath', '/r', '--allow-sibling'], client)
    expect(mutate).toHaveBeenCalledWith({
      repoPath: '/r',
      name: 'l',
      allowSibling: true,
    })
  })

  it('--ttl and --note ride through to the proc as ttlSeconds/note', async () => {
    const mutate = vi.fn(async () => grantedWire('l'))
    const client = { lock: { acquire: { mutate } } } as never
    await runLockCli(
      ['acquire', 'l', '--repoPath', '/r', '--ttl', '10m', '--note', 'deploy'],
      client,
    )
    expect(mutate).toHaveBeenCalledWith({
      repoPath: '/r',
      name: 'l',
      ttlSeconds: 600,
      note: 'deploy',
    })
  })

  it('acquire --wait polls until granted', async () => {
    const mutate = vi
      .fn()
      .mockResolvedValueOnce(queuedWire('l', 1))
      .mockResolvedValueOnce(queuedWire('l', 1))
      .mockResolvedValueOnce(grantedWire('l'))
    const client = { lock: { acquire: { mutate } } } as never
    const sleep = vi.fn(async () => {})
    const out = await runLockCli(['acquire', 'l', '--repoPath', '/r', '--wait'], client, { sleep })
    expect(out.exitCode).toBe(0)
    expect(mutate).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('acquire --wait backs off between polls instead of hammering acquire every 3s', async () => {
    const mutate = vi
      .fn()
      .mockResolvedValueOnce(queuedWire('l', 1))
      .mockResolvedValueOnce(queuedWire('l', 1))
      .mockResolvedValueOnce(queuedWire('l', 1))
      .mockResolvedValueOnce(grantedWire('l'))
    const client = { lock: { acquire: { mutate } } } as never
    const slept: number[] = []
    const out = await runLockCli(['acquire', 'l', '--repoPath', '/r', '--wait'], client, {
      sleep: async (ms) => {
        slept.push(ms)
      },
    })
    expect(out.exitCode).toBe(0)
    expect(slept).toEqual([3000, 4500, 6750])
  })

  it('bare --wait has no deadline: it stays queued through a hold past the old 300s cap', async () => {
    // The POD-612 shape: a holder that legitimately runs 13m+ while renewing.
    let nowMs = 0
    const mutate = vi.fn(async () =>
      nowMs >= 780_000 ? grantedWire('test:heavy') : queuedWire('test:heavy', 1),
    )
    const cancel = vi.fn(async () => ({ cancelled: true }))
    const client = { lock: { acquire: { mutate }, cancel: { mutate: cancel } } } as never
    const out = await runLockCli(['acquire', 'test:heavy', '--repoPath', '/r', '--wait'], client, {
      now: () => nowMs,
      sleep: async (ms) => {
        nowMs += ms
      },
    })
    expect(out.exitCode).toBe(0)
    expect(out.text).toContain("acquired 'test:heavy'")
    expect(nowMs).toBeGreaterThanOrEqual(780_000)
    expect(cancel).not.toHaveBeenCalled()
  })

  it('--timeout is honoured exactly as asked (no silent clamp) and leaves the queue on expiry', async () => {
    const mutate = vi.fn(async () => queuedWire('l', 2))
    const cancel = vi.fn(async () => ({ cancelled: true }))
    const client = { lock: { acquire: { mutate }, cancel: { mutate: cancel } } } as never
    let nowMs = 0
    const out = await runLockCli(
      // 9999s: the old loop silently clamped anything over 540s.
      ['acquire', 'l', '--repoPath', '/r', '--wait', '--timeout', '9999'],
      client,
      {
        now: () => nowMs,
        sleep: async (ms) => {
          nowMs += ms
        },
      },
    )
    expect(out.exitCode).toBe(EXIT_WAIT_TIMEOUT)
    expect(nowMs).toBe(9_999_000)
    expect(out.text).toContain('timed out after 2h46m39s')
    expect(out.text).toContain('left the queue — nothing will be granted to you now')
    expect(cancel).toHaveBeenCalledWith({ repoPath: '/r', name: 'l' })
  })

  it('a failed cancel at the deadline names the queue place still to clean up', async () => {
    const client = {
      lock: {
        acquire: { mutate: vi.fn(async () => queuedWire('l', 1)) },
        cancel: {
          mutate: vi.fn(async () => {
            throw new Error('gone')
          }),
        },
      },
    } as never
    let nowMs = 0
    const out = await runLockCli(
      ['acquire', 'l', '--repoPath', '/r', '--wait', '--timeout', '60'],
      client,
      {
        now: () => nowMs,
        sleep: async (ms) => {
          nowMs += ms
        },
      },
    )
    expect(out.exitCode).toBe(EXIT_WAIT_TIMEOUT)
    expect(out.text).toContain('could NOT leave the queue')
    expect(out.text).toContain('podium lock cancel l')
  })

  it('a grant landing in the deadline gap wins over the timeout (cancel refuses a holder)', async () => {
    const mutate = vi
      .fn()
      .mockResolvedValueOnce(queuedWire('l', 1))
      .mockResolvedValue(grantedWire('l'))
    const client = {
      lock: {
        acquire: { mutate },
        cancel: {
          mutate: vi.fn(async () => {
            throw new Error("you hold lock 'l' — use `release`, not cancel")
          }),
        },
      },
    } as never
    // The clock jumps to the deadline right after the first poll, so the
    // timeout path runs against a lock that has just been granted to us.
    let reads = 0
    const out = await runLockCli(
      ['acquire', 'l', '--repoPath', '/r', '--wait', '--timeout', '60'],
      client,
      { now: () => (reads++ === 0 ? 0 : 60_000), sleep: async () => {} },
    )
    expect(out.exitCode).toBe(0)
    expect(out.text).toContain("acquired 'l'")
  })

  it('an interrupted --wait leaves the queue before it exits', async () => {
    // The waiter row is keyed to the agent SESSION, which outlives this CLI
    // process — so nothing server-side would prune it. The CLI has to.
    const mutate = vi.fn(async () => queuedWire('test:heavy', 2))
    const cancel = vi.fn(async () => ({ cancelled: true }))
    const client = { lock: { acquire: { mutate }, cancel: { mutate: cancel } } } as never
    const controller = new AbortController()
    let nowMs = 0
    const out = await runLockCli(['acquire', 'test:heavy', '--repoPath', '/r', '--wait'], client, {
      signal: controller.signal,
      now: () => nowMs,
      sleep: async (ms) => {
        nowMs += ms
        if (nowMs >= 10_000) controller.abort() // Ctrl-C mid-sleep
      },
    })
    expect(out.exitCode).toBe(EXIT_INTERRUPTED)
    expect(out.text).toMatch(/^interrupted after \d+s waiting for 'test:heavy';/)
    expect(out.text).toContain('left the queue — nothing will be granted to you now')
    expect(cancel).toHaveBeenCalledWith({ repoPath: '/r', name: 'test:heavy' })
  })

  it('an interrupt that races a grant keeps the lock instead of cancelling it', async () => {
    // Granted on the very round the interrupt is seen: the grant wins, and the
    // caller is told to release what it now holds.
    const controller = new AbortController()
    const mutate = vi.fn(async () => {
      controller.abort()
      return grantedWire('l')
    })
    const cancel = vi.fn(async () => ({ cancelled: true }))
    const client = { lock: { acquire: { mutate }, cancel: { mutate: cancel } } } as never
    const out = await runLockCli(['acquire', 'l', '--repoPath', '/r', '--wait'], client, {
      signal: controller.signal,
      sleep: async () => {},
    })
    expect(out.exitCode).toBe(0)
    expect(out.text).toContain("acquired 'l'")
    expect(cancel).not.toHaveBeenCalled()
  })

  it('an interrupt whose cancel is refused because the grant landed reports the lock it now holds', async () => {
    const mutate = vi
      .fn()
      .mockResolvedValueOnce(queuedWire('l', 1))
      .mockResolvedValue(grantedWire('l'))
    const client = {
      lock: {
        acquire: { mutate },
        cancel: {
          mutate: vi.fn(async () => {
            throw new Error("you hold lock 'l' — use `release`, not cancel")
          }),
        },
      },
    } as never
    const controller = new AbortController()
    controller.abort()
    const out = await runLockCli(['acquire', 'l', '--repoPath', '/r', '--wait'], client, {
      signal: controller.signal,
      sleep: async () => {},
    })
    expect(out.exitCode).toBe(0)
    expect(out.text).toContain('granted as the wait was interrupted')
    expect(out.text).toContain('podium lock release l')
  })

  it('an already-aborted signal stops the wait after one round without sleeping', async () => {
    const mutate = vi.fn(async () => queuedWire('l', 1))
    const cancel = vi.fn(async () => ({ cancelled: true }))
    const client = { lock: { acquire: { mutate }, cancel: { mutate: cancel } } } as never
    const sleep = vi.fn(async () => {})
    const controller = new AbortController()
    controller.abort()
    const out = await runLockCli(['acquire', 'l', '--repoPath', '/r', '--wait'], client, {
      signal: controller.signal,
      sleep,
    })
    expect(out.exitCode).toBe(EXIT_INTERRUPTED)
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('a garbage --timeout is refused', async () => {
    const client = {
      lock: { acquire: { mutate: vi.fn(async () => queuedWire('l', 1)) } },
    } as never
    await expect(
      runLockCli(['acquire', 'l', '--repoPath', '/r', '--wait', '--timeout', 'soon'], client),
    ).rejects.toThrow(/invalid --timeout 'soon'/)
  })

  it('--wait narrates the queue so a long block is never silent', async () => {
    const mutate = vi
      .fn()
      .mockResolvedValueOnce(queuedWire('l', 3))
      .mockResolvedValueOnce(queuedWire('l', 3))
      .mockResolvedValueOnce(queuedWire('l', 1))
      .mockResolvedValueOnce(grantedWire('l'))
    const client = { lock: { acquire: { mutate } } } as never
    const lines: string[] = []
    const out = await runLockCli(['acquire', 'l', '--repoPath', '/r', '--wait'], client, {
      sleep: async () => {},
      onProgress: (l) => lines.push(l),
    })
    expect(out.exitCode).toBe(0)
    expect(lines).toEqual([
      "waiting until granted — queued for 'l' at position 3; held by s2 on issue:#2 workspace /wt/b [alive], expires in 10m0s",
      "'l': now position 1 (was 3)",
    ])
  })

  it('an unbudging queue still reports itself once a minute, so a long block never looks hung', async () => {
    const mutate = vi.fn(async () => queuedWire('l', 4))
    const client = {
      lock: { acquire: { mutate }, cancel: { mutate: vi.fn(async () => ({ cancelled: true })) } },
    } as never
    const lines: string[] = []
    let nowMs = 0
    await runLockCli(['acquire', 'l', '--repoPath', '/r', '--wait', '--timeout', '3m'], client, {
      now: () => nowMs,
      sleep: async (ms) => {
        nowMs += ms
      },
      onProgress: (l) => lines.push(l),
    })
    expect(lines[0]).toContain('waiting up to 3m')
    // Position never moves, so everything after the opener is a heartbeat —
    // roughly one a minute, not one per poll.
    const beats = lines.slice(1)
    expect(beats).toHaveLength(2)
    for (const beat of beats) {
      expect(beat).toMatch(/^'l': still queued at position 4 after \d+m\d*s?$/)
    }
  })

  it('cancel leaves the queue (and merge-lock maps it onto merge:<branch>)', async () => {
    const mutate = vi.fn(async () => ({ cancelled: true }))
    const client = { lock: { cancel: { mutate } } } as never
    const out = await runLockCli(mergeLockArgv(['cancel', '--repoPath', '/r']), client, {
      group: 'merge-lock',
    })
    expect(out.exitCode).toBe(0)
    expect(out.text).toContain("left the queue for 'merge:main'")
    expect(mutate).toHaveBeenCalledWith({ repoPath: '/r', name: 'merge:main' })
  })

  it('status renders the repo listing and release its confirmation', async () => {
    const client = {
      lock: {
        status: {
          query: vi.fn(async () => [{ ...grantedWire('merge:main').lock, queue: [] }]),
        },
        release: { mutate: vi.fn(async () => ({ released: true, next: null })) },
      },
    } as never
    const st = await runLockCli(['status', '--repoPath', '/r'], client)
    expect(st.exitCode).toBe(0)
    expect(st.text).toContain('merge:main')
    const rel = await runLockCli(['release', 'merge:main', '--repoPath', '/r'], client)
    expect(rel.text).toContain("released 'merge:main'")
  })

  it('unknown command and missing args throw (exit 1 in main)', async () => {
    const client = { lock: {} } as never
    await expect(runLockCli(['nope'], client)).rejects.toThrow(/unknown command/)
    await expect(runLockCli(['acquire'], client)).rejects.toThrow(/invalid args/)
  })

  it('merge-lock argv mapped through runLockCli hits the same procs with merge:<branch>', async () => {
    const mutate = vi.fn(async () => grantedWire('merge:develop'))
    const client = { lock: { acquire: { mutate } } } as never
    const out = await runLockCli(
      mergeLockArgv(['acquire', '--branch', 'develop', '--repoPath', '/r']),
      client,
      { group: 'merge-lock' },
    )
    expect(out.exitCode).toBe(0)
    expect(mutate).toHaveBeenCalledWith({ repoPath: '/r', name: 'merge:develop' })
  })
})
