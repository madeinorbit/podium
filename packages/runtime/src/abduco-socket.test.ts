import { describe, expect, it } from 'vitest'
import {
  ABDUCO_SUN_PATH_MAX,
  abducoSocketDir,
  abducoSocketPathBytes,
  abducoSocketPathFits,
  instanceAbducoSocketRoot,
  longestDurableLabelFor,
} from './abduco-socket.js'

/**
 * POD-2853. A named instance could not start ANY terminal session: the socket
 * path it composed was longer than `sun_path` and abduco refused every create.
 *
 * These are arithmetic tests on purpose. The failure is a byte count against a
 * kernel constant, and a test that only asserted "some root was chosen" would
 * have passed against the bug — the old pin chose a root too, it was just 13
 * bytes too long. Every case below names the number.
 *
 * The rig fixes username, hostname and uid rather than reading the host's, so
 * the boundaries are properties of the composition and not of this machine.
 */
const RIG = { username: 'u', hostname: 'h', uid: 1000 } as const
const ENV = { XDG_RUNTIME_DIR: '/run/user/1000' } as NodeJS.ProcessEnv
const HOST = `@${RIG.hostname}`

const composed = (root: string, id: string) =>
  abducoSocketPathBytes(abducoSocketDir(root, RIG.username), longestDurableLabelFor(id), HOST)

describe('the abduco socket budget', () => {
  it('measures what abduco measures, including the trailing slash', () => {
    // create_socket_dir leaves `<root>/abduco/<user>/` in sun_path — with the
    // slash. Dropping it understates every composition by one byte, which is
    // the whole margin at the boundary.
    expect(abducoSocketDir('/run/user/1000/podium-blue', 'u')).toBe(
      '/run/user/1000/podium-blue/abduco/u/',
    )
    expect(abducoSocketPathBytes('/abc/', 'label', '@h')).toBe(5 + 5 + 2)
  })

  it('refuses at the limit, not past it — abduco compares with >=', () => {
    const host = '@h'
    const label = 'x'.repeat(10)
    const exact = 'd'.repeat(ABDUCO_SUN_PATH_MAX - label.length - host.length)
    expect(abducoSocketPathBytes(exact, label, host)).toBe(ABDUCO_SUN_PATH_MAX)
    expect(abducoSocketPathFits(exact, label, host)).toBe(false)
    expect(abducoSocketPathFits(exact.slice(1), label, host)).toBe(true)
  })

  it('budgets the CLIENT TERMINAL label, which is longer than the session one below 8 characters', () => {
    // Two shapes: `podium-<instance>-<uuid>` (44 + len(id)) and
    // `podium-<token>-attach-<uuid>` (53, NOT instance-prefixed). POD-2777
    // found this: on a short instance id the native view overflows by four
    // bytes MORE than the spawn does, so budgeting the session label alone
    // leaves a blank terminal pane on an instance whose sessions start fine.
    expect(longestDurableLabelFor('blue')).toHaveLength(53) // client terminal wins
    // BOTH EDGES of the crossover, which is at NINE characters: the session
    // label is 44 + len(id), so it first reaches the attach label's 53 at 9 and
    // only exceeds it at 10.
    expect(longestDurableLabelFor('i'.repeat(8))).toHaveLength(53)
    expect(longestDurableLabelFor('i'.repeat(9))).toHaveLength(53)
    expect(longestDurableLabelFor('i'.repeat(10))).toHaveLength(54)
    // And every uuid is 36 bytes, which is what makes this a constant of the
    // instance rather than something to recompute per spawn.
    expect(longestDurableLabelFor('i'.repeat(10))).toBe(
      `podium-${'i'.repeat(10)}-${'0'.repeat(36)}`,
    )
  })
})

describe('the root a named instance pins', () => {
  it('takes the private per-instance runtime root when it fits', () => {
    expect(instanceAbducoSocketRoot('blue', ENV, RIG)).toBe('/run/user/1000/podium-blue')
    expect(composed('/run/user/1000/podium-blue', 'blue')).toBeLessThan(ABDUCO_SUN_PATH_MAX)
  })

  it('gives up per-instance isolation only when the id no longer fits, at 15 characters', () => {
    // BOTH EDGES. The private root costs the instance id twice — once in the
    // directory and once in the label — so it runs out first, and where it runs
    // out is the fact worth pinning. 14 is the last id that keeps a private
    // root; 15 is the first that has to share one with other instances, which
    // costs nothing but a shared `abduco` listing (labels still carry the id).
    const last = 'i'.repeat(14)
    const first = 'i'.repeat(15)
    expect(instanceAbducoSocketRoot(last, ENV, RIG)).toBe(`/run/user/1000/podium-${last}`)
    expect(composed(`/run/user/1000/podium-${last}`, last)).toBe(ABDUCO_SUN_PATH_MAX - 2)
    expect(instanceAbducoSocketRoot(first, ENV, RIG)).toBe('/run/user/1000/podium')
    expect(composed(`/run/user/1000/podium-${first}`, first)).toBe(ABDUCO_SUN_PATH_MAX)
  })

  it('leaves the runtime directory for /tmp only at 31 characters', () => {
    const last = 'i'.repeat(30)
    const first = 'i'.repeat(31)
    expect(instanceAbducoSocketRoot(last, ENV, RIG)).toBe('/run/user/1000/podium')
    expect(instanceAbducoSocketRoot(first, ENV, RIG)).toBe('/tmp/podium-1000')
  })

  it('spends the real hostname, not a placeholder', () => {
    // `@<hostname>` is 10 bytes of 108 on this host and can be far more on
    // another. Budgeting a short stand-in would under-count and hand back a
    // root that does not in fact fit — the exact failure this whole module
    // exists to prevent, reintroduced one level up.
    const id = 'i'.repeat(14) // the last id that keeps a private root at host `h`
    expect(instanceAbducoSocketRoot(id, ENV, RIG)).toBe(`/run/user/1000/podium-${id}`)
    // Seven more bytes of hostname and the SAME instance loses its private
    // root. A placeholder host would have kept handing back the private one
    // and abduco would have refused it.
    expect(instanceAbducoSocketRoot(id, ENV, { ...RIG, hostname: 'longhost' })).toBe(
      '/run/user/1000/podium',
    )
    // Far enough and even the shared runtime root goes.
    expect(instanceAbducoSocketRoot(id, ENV, { ...RIG, hostname: 'a-much-longer-host' })).toBe(
      '/tmp/podium-1000',
    )
  })

  it('names /tmp by uid, because /tmp is world writable', () => {
    // A root another user could create first is a root abduco will refuse
    // (it checks ownership and mode on the per-user subdirectory) and the
    // instance would silently fall through to somewhere else entirely.
    expect(instanceAbducoSocketRoot('blue', {}, RIG)).toBe('/tmp/podium-1000')
    expect(instanceAbducoSocketRoot('blue', { TMPDIR: '/scratch' }, RIG)).toBe(
      '/scratch/podium-1000',
    )
  })

  it('returns the shortest root rather than nothing when none fits', () => {
    // WHERE THE BUDGET RUNS OUT ENTIRELY DEPENDS ON THE HOST, not just on the
    // instance id: the user name and the hostname are in the same 108 bytes. A
    // 32-character id — the longest INSTANCE_ID_PATTERN allows — spends 76 on
    // the label alone, and on a real host (`mgw` on `flatblock`) that leaves
    // nothing that fits. Under this file's one-letter rig the very same id
    // still fits, which is why the case is written against real names.
    const huge = 'i'.repeat(32)
    const real = { username: 'mgw', hostname: 'flatblock', uid: 1001 } as const
    const bytes = abducoSocketPathBytes(
      abducoSocketDir('/tmp/podium-1001', real.username),
      longestDurableLabelFor(huge),
      `@${real.hostname}`,
    )
    expect(bytes).toBeGreaterThan(ABDUCO_SUN_PATH_MAX)
    // The shortest root is handed back anyway: the spawn then runs and reports
    // the measured overflow with the path in it. Handing back nothing would
    // drop the instance onto $HOME/.abduco — shared with the default instance,
    // and on the documented state layout too long as well.
    expect(instanceAbducoSocketRoot(huge, { XDG_RUNTIME_DIR: '/run/user/1001' }, real)).toBe(
      '/tmp/podium-1001',
    )
  })
})

describe('why the state directory cannot hold the socket', () => {
  // The numbers this issue was opened on, kept as a regression pin. Read with
  // the host that measured them (user `mgw`, host `flatblock`) so they are the
  // same numbers the evidence and the drive log report.
  const REAL = { username: 'mgw', hostname: 'flatblock' } as const
  const realHost = `@${REAL.hostname}`
  const bytesUnder = (root: string, id: string) =>
    abducoSocketPathBytes(
      abducoSocketDir(root, REAL.username),
      longestDurableLabelFor(id),
      realHost,
    )

  it('was 121 bytes with the doubled segment and 114 without it', () => {
    // The SESSION label, spelled out rather than taken from
    // `longestDurableLabelFor`: these are the numbers the drive measured on a
    // real session spawn, and that helper now answers with the longer
    // client-terminal shape. A pin that drifted with the helper would stop
    // naming the thing that was reported.
    const sessionLabel = `podium-p2853-${'0'.repeat(36)}`
    const state = '/home/mgw/.local/state/podium/p2853'
    const under = (root: string) =>
      abducoSocketPathBytes(abducoSocketDir(root, REAL.username), sessionLabel, realHost)
    expect(sessionLabel).toHaveLength(49)
    expect(under(`${state}/runtime/abduco`)).toBe(121)
    // De-duplicating `abduco/abduco` buys 7 bytes and is STILL over the limit,
    // which is why this fix moves the root instead of tidying the old one.
    expect(under(`${state}/runtime`)).toBe(114)
    expect(ABDUCO_SUN_PATH_MAX).toBe(108)
  })

  it('fits once the root comes from the runtime directory', () => {
    expect(
      bytesUnder(
        instanceAbducoSocketRoot(
          'p2853',
          { XDG_RUNTIME_DIR: '/run/user/1001' },
          { ...REAL, uid: 1001 },
        ),
        'p2853',
      ),
    ).toBeLessThan(ABDUCO_SUN_PATH_MAX)
  })
})
