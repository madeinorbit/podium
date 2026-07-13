import { describe, expect, it, vi } from 'vitest'
import {
  EXIT_QUEUED,
  EXIT_WAIT_TIMEOUT,
  mergeLockArgv,
  parseLockArgs,
  runLockCli,
} from './lock-cli'

/**
 * `podium lock` / `podium merge-lock` CLI dispatch [spec:SP-85d1] —
 * mocked-client style (see issue-cli.test.ts): parse, positional mapping, the
 * merge:<branch> name mapping, exit-code contract (0 granted · 3 queued ·
 * 4 wait-timeout), and the --wait poll loop.
 */

const grantedWire = (name: string) => ({
  granted: true,
  alreadyHeld: false,
  lock: {
    repoId: 'r',
    name,
    holder: { sessionId: 's1', issueId: null, label: 'session:s1' },
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
    holder: { sessionId: 's2', issueId: null, label: 'issue:#2' },
  },
})

describe('parseLockArgs', () => {
  it('parses command, positionals, flags, and bool flags (--wait takes no value)', () => {
    const r = parseLockArgs(['acquire', 'merge:main', '--ttl', '10m', '--wait', '--timeout', '30'])
    expect(r.command).toBe('acquire')
    expect(r.positionals).toEqual(['merge:main'])
    expect(r.args).toMatchObject({ ttl: '10m', wait: true, timeout: '30' })
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

  it('acquire --wait times out with its own exit code (timeout capped at 540s) and auto-cancels the waiter', async () => {
    const mutate = vi.fn(async () => queuedWire('l', 1))
    const cancel = vi.fn(async () => ({ cancelled: true }))
    const client = { lock: { acquire: { mutate }, cancel: { mutate: cancel } } } as never
    let nowMs = 0
    const out = await runLockCli(
      ['acquire', 'l', '--repoPath', '/r', '--wait', '--timeout', '9999'],
      client,
      {
        now: () => nowMs,
        sleep: async () => {
          nowMs += 300_000 // two sleeps blow past the 540s cap
        },
      },
    )
    expect(out.exitCode).toBe(EXIT_WAIT_TIMEOUT)
    expect(out.text).toContain('timed out after 540s')
    expect(cancel).toHaveBeenCalledWith({ repoPath: '/r', name: 'l' })
  })

  it('--wait timeout still exits 4 when the best-effort cancel fails', async () => {
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
    const out = await runLockCli(['acquire', 'l', '--repoPath', '/r', '--wait'], client, {
      now: () => nowMs,
      sleep: async () => {
        nowMs += 600_000
      },
    })
    expect(out.exitCode).toBe(EXIT_WAIT_TIMEOUT)
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
