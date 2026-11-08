/**
 * A PLAIN `{ cmd, args }` DOES NOT COMPILE AT A HARNESS SPAWN SITE (POD-6536,
 * design docs/design/harness-access-contract.md §3.4).
 *
 * Each `@ts-expect-error` below is the proof: if a spawn site ever accepts an
 * unbound command again, the directive is unused and `bun run typecheck` (which
 * checks test files) fails. The runtime half only shows the bound forms are
 * the ones that type-check.
 */
import { type BoundCommand, harnessCommand, shellCommand } from '@podium/harness'
import type { EngineSpawnRequest } from '@podium/harness/driver/host'
import { testHarnessContext } from '@podium/harness/driver/testing'
import { describe, expect, it } from 'vitest'
import type { BufferedHarnessRunChild } from '../buffered-harness.js'
import type { ClientProcessOwner } from './clients.js'
import type { SessionSpawnOptions } from './harness-spawn.js'

const plain = { cmd: 'codex', args: ['app-server'] }
const context = testHarnessContext({ kind: 'codex', executable: '/opt/podium-test/bin/codex' })
const bound: BoundCommand = harnessCommand(context, { args: ['app-server'] })

describe('harness spawn sites take only a BoundCommand', () => {
  it('the PTY session spawn', () => {
    const ok: SessionSpawnOptions = { label: 'l', command: bound }
    const shell: SessionSpawnOptions = {
      label: 'l',
      command: shellCommand({ cmd: '/bin/sh', args: [] }),
    }
    // @ts-expect-error a plain { cmd, args } is not a launchable session command
    const refused: SessionSpawnOptions = { label: 'l', command: plain }
    expect([ok, shell, refused].length).toBe(3)
  })

  it("the engine owner's startEngine", () => {
    const base = { label: 'l', cwd: '/', env: {}, stripEnv: [] }
    const ok: EngineSpawnRequest = { ...base, command: bound }
    // @ts-expect-error a plain { cmd, args } is not an engine command
    const refused: EngineSpawnRequest = { ...base, command: plain }
    // @ts-expect-error nor are the old flat cmd/args fields
    const flat: EngineSpawnRequest = { ...base, cmd: 'codex', args: [] }
    expect([ok, refused, flat].length).toBe(3)
  })

  it('buffered exec', () => {
    const run: BufferedHarnessRunChild = async () => ({ stdout: '' })
    const opts = { timeout: 1, maxBuffer: 1, env: {} }
    void run(bound, opts, '')
    // @ts-expect-error a plain { cmd, args } cannot reach the buffered exec child
    void run(plain, opts, '')
    expect(typeof run).toBe('function')
  })

  it("the attach client's spawnClient", () => {
    const spawnClient: ClientProcessOwner['spawnClient'] = async () => {
      throw new Error('not spawned')
    }
    void spawnClient({ label: 'l', command: bound }).catch(() => undefined)
    // @ts-expect-error a plain { cmd, args } is not a client terminal command
    void spawnClient({ label: 'l', command: plain }).catch(() => undefined)
    // A shell is not a harness client either.
    // @ts-expect-error a ShellCommand is not a BoundCommand
    void spawnClient({ label: 'l', command: shellCommand(plain) }).catch(() => undefined)
    expect(typeof spawnClient).toBe('function')
  })
})
