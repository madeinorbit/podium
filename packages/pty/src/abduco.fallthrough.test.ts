import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { abducoSocketPath, reapStaleAbducoBindTemps } from './abduco.js'

/**
 * POD-2853, defect 2: THE PROBE MUST LOOK EVERYWHERE THE CREATE COULD HAVE PUT IT.
 *
 * abduco does not resolve one socket directory. It walks four in order —
 * ABDUCO_SOCKET_DIR, HOME, TMPDIR, /tmp (config.h) — and moves to the next on
 * ANY failure of the current one, saying nothing: the create SUCCEEDS, at a
 * different root. Podium's resolver mirrored only the first, so a master that
 * fell through was invisible to every caller that asks whether a label is
 * alive, and the spawn path reported "did not publish a live socket" for a
 * session that was running.
 *
 * Measured before the fix, with the real binary: an abduco master created with
 * ABDUCO_SOCKET_DIR pointing at a directory whose parent did not exist put its
 * socket in `/tmp/abduco/<user>` and stayed alive there, while
 * `abducoSocketPath` called with THAT SAME ENVIRONMENT answered `undefined`.
 *
 * Each case below is one rung of abduco's chain, with the environment naming a
 * root the master is NOT under — because "found it where I was told to look" is
 * not the property that was broken.
 *
 * Nothing creates abduco sessions any more (POD-4986), but every master an
 * older Podium created is ADOPTED, and it sits wherever that create landed:
 * the chain is how the daemon finds it again.
 */
const roots: string[] = []
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'podium-abduco-chain-'))
  roots.push(dir)
  return dir
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const USER = 'tester'
const LABEL = 'podium-blue-00000000-1111-2222-3333-444444444444'

/** A LIVE master's socket: abduco clears S_IXGRP while the app is running. */
const liveSocket = (dir: string, name = `${LABEL}@somehost`): string => {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, '')
  chmodSync(path, 0o600)
  return path
}

describe("abducoSocketPath follows abduco's whole fall-through chain", () => {
  it('finds a master under ABDUCO_SOCKET_DIR — the rung that already worked', () => {
    const root = temp()
    const socket = liveSocket(join(root, 'abduco', USER))
    expect(abducoSocketPath(LABEL, { ABDUCO_SOCKET_DIR: root }, USER)).toBe(socket)
  })

  it('finds one that fell through to $HOME/.abduco with ABDUCO_SOCKET_DIR set', () => {
    // The reported shape: the variable is set (by the instance pin, or by an
    // operator working around the length limit) and abduco could not use it.
    const root = temp()
    const home = temp()
    const socket = liveSocket(join(home, '.abduco'))
    expect(abducoSocketPath(LABEL, { ABDUCO_SOCKET_DIR: root, HOME: home }, USER)).toBe(socket)
  })

  it('finds one that fell through to $TMPDIR', () => {
    const root = temp()
    const scratch = temp()
    const socket = liveSocket(join(scratch, 'abduco', USER))
    expect(abducoSocketPath(LABEL, { ABDUCO_SOCKET_DIR: root, TMPDIR: scratch }, USER)).toBe(socket)
  })

  it('finds one that fell through all the way past HOME to TMPDIR', () => {
    // BOTH earlier rungs unusable, which is the case the real measurement hit:
    // a missing ABDUCO_SOCKET_DIR parent AND a HOME with no .abduco.
    const scratch = temp()
    const socket = liveSocket(join(scratch, 'abduco', USER))
    expect(
      abducoSocketPath(
        LABEL,
        { ABDUCO_SOCKET_DIR: join(temp(), 'missing', 'deeper'), HOME: temp(), TMPDIR: scratch },
        USER,
      ),
    ).toBe(socket)
  })

  it('still prefers the root it was told to use when a master is in both', () => {
    // ORDER IS ABDUCO'S ORDER. Widening the search must not change which socket
    // wins when more than one carries the label: abduco itself would have taken
    // ABDUCO_SOCKET_DIR, so the probe answering with the TMPDIR copy would name
    // a master that is not the one abduco itself would attach to.
    const root = temp()
    const scratch = temp()
    const preferred = liveSocket(join(root, 'abduco', USER))
    liveSocket(join(scratch, 'abduco', USER))
    expect(abducoSocketPath(LABEL, { ABDUCO_SOCKET_DIR: root, TMPDIR: scratch }, USER)).toBe(
      preferred,
    )
  })

  it('still skips a TERMINATED master wherever it fell through to', () => {
    // The liveness rule is not relaxed by the wider search: a master holding
    // only an exit status (S_IXGRP set) is not a live session, and finding one
    // in /tmp must not make a dead session look alive.
    const scratch = temp()
    const dir = join(scratch, 'abduco', USER)
    mkdirSync(dir, { recursive: true })
    const dead = join(dir, `${LABEL}@somehost`)
    writeFileSync(dead, '')
    chmodSync(dead, 0o610)
    expect(abducoSocketPath(LABEL, { ABDUCO_SOCKET_DIR: temp(), TMPDIR: scratch }, USER)).toBe(
      undefined,
    )
  })

  it('sweeps bind temps from the rungs the master can land on', () => {
    // reapStaleAbducoBindTemps walks the same chain, and it SHOULD: a create
    // that fell through leaks its `.abduco-<pid>` probe in the root it fell
    // through TO, and nothing was reaping those.
    const scratch = temp()
    const dir = join(scratch, 'abduco', USER)
    mkdirSync(dir, { recursive: true })
    const dead = join(dir, `.abduco-${2 ** 30}`) // beyond pid_max — never alive
    writeFileSync(dead, '')
    expect(reapStaleAbducoBindTemps({ ABDUCO_SOCKET_DIR: temp(), TMPDIR: scratch }, USER)).toEqual([
      dead,
    ])
  })
})
