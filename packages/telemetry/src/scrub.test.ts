/**
 * Scrubber tests [spec:SP-f933] — the hostile-input suite.
 *
 * The premise: assume the user's machine is full of things that must not leave
 * it (their name, their employer's repo name, their client's project) and that
 * all of them appear in stack traces. Every test below is a real leak we are
 * choosing to make impossible, not a hypothetical.
 */
import { describe, expect, it } from 'vitest'
import { crashSignature, scrubError, scrubFrame, scrubStack } from './scrub'

const INSTALL = '/home/alice/.podium/current'

describe('scrubFrame — install containment', () => {
  it('keeps a Podium source frame as an install-relative path', () => {
    expect(
      scrubFrame(
        { file: `${INSTALL}/apps/server/src/router.ts`, line: 412, fn: 'handleSession' },
        INSTALL,
      ),
    ).toEqual({ file: 'apps/server/src/router.ts', line: 412, fn: 'handleSession' })
  })

  it("drops a frame in the user's own repo — never rewrites it to a basename", () => {
    // The leak this exists to prevent: 'secret-repo/billing.ts' is still the
    // user's data even with the directory stripped off.
    expect(
      scrubFrame({ file: '/home/alice/work/acme-secret-repo/src/billing.ts', line: 9 }, INSTALL),
    ).toBeUndefined()
  })

  it('drops node internals', () => {
    expect(
      scrubFrame({ file: 'node:internal/modules/cjs/loader', line: 1 }, INSTALL),
    ).toBeUndefined()
    expect(scrubFrame({ file: 'node:events', line: 517, fn: 'emit' }, INSTALL)).toBeUndefined()
  })

  it('drops node_modules frames even INSIDE the install', () => {
    expect(
      scrubFrame({ file: `${INSTALL}/node_modules/hono/dist/index.js`, line: 12 }, INSTALL),
    ).toBeUndefined()
    expect(
      scrubFrame(
        { file: `${INSTALL}/apps/server/node_modules/zod/lib/index.js`, line: 3 },
        INSTALL,
      ),
    ).toBeUndefined()
  })

  it('drops a path that escapes the install root with ..', () => {
    expect(
      scrubFrame({ file: `${INSTALL}/apps/../../../etc/passwd.ts`, line: 1 }, INSTALL),
    ).toBeUndefined()
  })

  it('drops a file inside the install that is not on a known source root', () => {
    // e.g. the user dropped a script next to the install — not ours to report.
    expect(scrubFrame({ file: `${INSTALL}/my-notes.ts`, line: 1 }, INSTALL)).toBeUndefined()
    expect(scrubFrame({ file: `${INSTALL}/secret-stuff/x.ts`, line: 1 }, INSTALL)).toBeUndefined()
  })

  it('drops a sibling directory whose name merely starts with the install path', () => {
    // '/home/alice/.podium/current-backup-acme' must not pass as inside
    // '/home/alice/.podium/current' — a prefix check without the separator would.
    expect(
      scrubFrame({ file: '/home/alice/.podium/current-backup-acme/apps/x.ts', line: 1 }, INSTALL),
    ).toBeUndefined()
  })

  it('handles file:// URLs', () => {
    expect(
      scrubFrame(
        { file: `file://${INSTALL}/packages/runtime/src/config.ts`, line: 187, fn: 'saveConfig' },
        INSTALL,
      ),
    ).toEqual({ file: 'packages/runtime/src/config.ts', line: 187, fn: 'saveConfig' })
  })

  it('handles a bun --compile virtual path', () => {
    // Shipped binaries report frames under /$bunfs/root; without this the
    // entire crash tier would be silently empty in production.
    expect(
      scrubFrame({ file: '/$bunfs/root/apps/server/src/relay.ts', line: 22, fn: 'send' }, INSTALL),
    ).toEqual({ file: 'apps/server/src/relay.ts', line: 22, fn: 'send' })
  })

  it('keeps the location but drops a function name that is not an identifier', () => {
    expect(
      scrubFrame(
        { file: `${INSTALL}/apps/server/src/router.ts`, line: 5, fn: 'handler for /home/alice/x' },
        INSTALL,
      ),
    ).toEqual({ file: 'apps/server/src/router.ts', line: 5 })
  })
})

describe('scrubFrame — hostile Windows paths', () => {
  const WIN_INSTALL = 'C:\\Users\\Alice Smith\\AppData\\Local\\Podium'

  it('keeps an install-relative Windows frame', () => {
    expect(
      scrubFrame(
        { file: `${WIN_INSTALL}\\apps\\server\\src\\router.ts`, line: 3, fn: 'go' },
        WIN_INSTALL,
      ),
    ).toEqual({ file: 'apps/server/src/router.ts', line: 3, fn: 'go' })
  })

  it("drops a Windows frame in the user's own tree — the username must not survive", () => {
    const scrubbed = scrubFrame(
      { file: 'C:\\Users\\Alice Smith\\Documents\\acme\\app.ts', line: 3 },
      WIN_INSTALL,
    )
    expect(scrubbed).toBeUndefined()
  })
})

describe('scrubFrame — symlinked worktrees', () => {
  it('drops a worktree path that only LOOKS like install-adjacent source', () => {
    // A symlinked worktree resolves elsewhere; we never realpath (that is how a
    // user path would get laundered INTO the install). Textually outside = dropped.
    expect(
      scrubFrame(
        { file: '/home/alice/src/podium/.worktrees/acme-feature/apps/server/src/x.ts', line: 1 },
        INSTALL,
      ),
    ).toBeUndefined()
  })

  it('a worktree symlinked under the install still cannot smuggle a repo name', () => {
    // Even reached THROUGH the install dir, the emitted path can only ever be
    // install-relative Podium source — the repo name is not in the frame at all.
    const scrubbed = scrubFrame(
      { file: `${INSTALL}/apps/server/src/router.ts`, line: 1, fn: 'x' },
      INSTALL,
    )
    expect(JSON.stringify(scrubbed)).not.toContain('acme')
  })
})

describe('scrubStack', () => {
  const stack = [
    'TypeError: Cannot read properties of undefined (reading /home/alice/acme-corp/secrets.json)',
    `    at handleSession (${INSTALL}/apps/server/src/router.ts:412:15)`,
    `    at async Object.saveConfig (${INSTALL}/packages/runtime/src/config.ts:187:3)`,
    `    at Module._compile (node:internal/modules/cjs/loader:1105:14)`,
    `    at userCode (/home/alice/acme-corp/src/plugin.ts:8:1)`,
    `    at ${INSTALL}/node_modules/hono/dist/hono.js:44:9`,
  ].join('\n')

  it('keeps only Podium frames, in order', () => {
    expect(scrubStack(stack, INSTALL)).toEqual([
      { file: 'apps/server/src/router.ts', line: 412, fn: 'handleSession' },
      { file: 'packages/runtime/src/config.ts', line: 187, fn: 'Object.saveConfig' },
    ])
  })

  it('never lets the message line through — it is not even parsed as a frame', () => {
    const json = JSON.stringify(scrubStack(stack, INSTALL))
    expect(json).not.toContain('acme-corp')
    expect(json).not.toContain('secrets.json')
    expect(json).not.toContain('Cannot read properties')
    expect(json).not.toContain('alice')
  })

  it('handles an undefined stack', () => {
    expect(scrubStack(undefined, INSTALL)).toEqual([])
  })

  it('caps the frame count', () => {
    const many = Array.from(
      { length: 50 },
      (_, i) => `    at fn${i} (${INSTALL}/apps/server/src/router.ts:${i + 1}:1)`,
    ).join('\n')
    expect(scrubStack(`Error: x\n${many}`, INSTALL, 20)).toHaveLength(20)
  })
})

describe('scrubError', () => {
  it('drops the message entirely and keeps the closed-enum type', () => {
    const err = new TypeError('failed to open /home/alice/acme/private.key')
    err.stack = [
      'TypeError: failed to open /home/alice/acme/private.key',
      `    at boot (${INSTALL}/apps/server/src/server.ts:120:5)`,
    ].join('\n')
    const scrubbed = scrubError(err, INSTALL)
    expect(scrubbed.errorType).toBe('TypeError')
    expect(scrubbed.frames).toEqual([{ file: 'apps/server/src/server.ts', line: 120, fn: 'boot' }])
    expect(JSON.stringify(scrubbed)).not.toContain('private.key')
    expect(JSON.stringify(scrubbed)).not.toContain('alice')
  })

  it('folds a custom error class to Other (no class names off the machine)', () => {
    class AcmeCorpDbError extends Error {}
    const err = new AcmeCorpDbError('boom')
    err.stack = `AcmeCorpDbError: boom\n    at q (${INSTALL}/apps/server/src/store.ts:1:1)`
    expect(scrubError(err, INSTALL).errorType).toBe('Other')
  })

  it('survives a non-Error throw', () => {
    expect(scrubError('a string with /home/alice in it', INSTALL)).toEqual({
      errorType: 'Other',
      frames: [],
    })
  })
})

describe('crashSignature', () => {
  it('is built only from scrubbed values', () => {
    const err = new TypeError('x')
    err.stack = `TypeError: x\n    at boot (${INSTALL}/apps/server/src/server.ts:120:5)`
    expect(crashSignature(scrubError(err, INSTALL))).toBe('TypeError@apps/server/src/server.ts:120')
  })

  it('distinguishes a no-frames crash rather than colliding on empty', () => {
    expect(crashSignature({ errorType: 'Error', frames: [] })).toBe('Error@no-frames')
  })
})
