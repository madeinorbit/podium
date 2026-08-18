import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { createSecurityRunner, SECURITY_PATH, type SecuritySpawn } from './claude-keychain-security'

function fakeChild(): ChildProcessWithoutNullStreams {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  }) as unknown as ChildProcessWithoutNullStreams
}

describe('production security runner buffer ownership', () => {
  it('clears source stream chunks after copying bounded output', async () => {
    const child = fakeChild()
    const spawnProcess = vi.fn(() => child) as unknown as SecuritySpawn
    const runner = createSecurityRunner(spawnProcess)
    const pending = runner.run(['find-generic-password'])
    const stdoutSource = Buffer.from('{"token":"synthetic-only"}\n')
    const stderrSource = Buffer.from('synthetic diagnostic')

    child.stdout.emit('data', stdoutSource)
    child.stderr.emit('data', stderrSource)
    expect(stdoutSource.equals(Buffer.alloc(stdoutSource.length))).toBe(true)
    expect(stderrSource.equals(Buffer.alloc(stderrSource.length))).toBe(true)
    child.emit('close', 0, null)

    const result = await pending
    try {
      expect(result.stdout.toString()).toBe('{"token":"synthetic-only"}\n')
      expect(result.stderr).toBe('synthetic diagnostic')
      expect(spawnProcess).toHaveBeenCalledWith(
        SECURITY_PATH,
        ['find-generic-password'],
        expect.objectContaining({ shell: false }),
      )
    } finally {
      result.stdout.fill(0)
    }
  })
})
