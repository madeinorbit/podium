import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureInstanceStateIdentity } from '@podium/runtime/instance'
import { instanceCliMain } from './instance-cli'

const savedEnv = { ...process.env }
const roots: string[] = []

afterEach(() => {
  if (savedEnv.PODIUM_INSTANCE === undefined) delete process.env.PODIUM_INSTANCE
  else process.env.PODIUM_INSTANCE = savedEnv.PODIUM_INSTANCE
  if (savedEnv.PODIUM_STATE_DIR === undefined) delete process.env.PODIUM_STATE_DIR
  else process.env.PODIUM_STATE_DIR = savedEnv.PODIUM_STATE_DIR
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('instance cli', () => {
  it('rekeys a state root while preserving the instance id', () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-instance-cli-'))
    roots.push(root)
    process.env.PODIUM_INSTANCE = 'blue'
    process.env.PODIUM_STATE_DIR = root
    const before = ensureInstanceStateIdentity({ instanceId: 'blue', dir: root })
    const output: string[] = []

    const code = instanceCliMain(['rekey'], {
      print: (message) => output.push(message),
      error: (message) => output.push(`error: ${message}`),
    })

    expect(code).toBe(0)
    const after = JSON.parse(readFileSync(join(root, 'instance.json'), 'utf8'))
    expect(after.instanceId).toBe('blue')
    expect(after.instanceUuid).not.toBe(before.instanceUuid)
    expect(output[0]).toContain(`${before.instanceUuid} -> ${after.instanceUuid}`)
  })

  it('has a bounded command surface', () => {
    const output: string[] = []
    expect(
      instanceCliMain(['unknown'], {
        print: (message) => output.push(message),
        error: (message) => output.push(message),
      }),
    ).toBe(2)
    expect(output[0]).toBe('usage: podium instance rekey')
  })
})
