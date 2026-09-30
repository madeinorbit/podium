import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { hasLegacyAbduco, legacyAbducoBin, oldAbducoBin } from './legacy-abduco-fixture.js'
import { attachAbducoAgent } from './abduco.js'
import { probeAbducoPid } from './abduco-client.js'
import { createDurableProcess } from './durable-process.js'

/** Real released masters only; no vendor source or compiler dependency in Podium. */
const root = mkdtempSync('/tmp/an-')
afterAll(() => rmSync(root, { recursive: true, force: true }))
const waitFor = async (condition: () => boolean): Promise<void> => {
  const deadline = Date.now() + 5000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('legacy adoption timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

for (const [name, bin] of [
  ['old master', oldAbducoBin],
  ['latest released master', legacyAbducoBin],
] as const) {
  describe.skipIf(!hasLegacyAbduco || !bin)(`native adoption of ${name}`, () => {
    it('is size-neutral, round-trips input, resizes the child tty, detaches, re-adopts and sees exit', async () => {
      const socket = join(root, name === 'old master' ? 'old' : 'new')
      // Absolute socket names have no fall-through to the operator's directories.
      execFileSync(
        bin as string,
        [
          '-n',
          socket,
          '/bin/sh',
          '-c',
          'while IFS= read -r line; do if [ "$line" = exit ]; then exit 23; fi; printf "ROUND:%s SIZE:" "$line"; stty size; done',
        ],
        { stdio: 'ignore' },
      )
      const pid = await probeAbducoPid(socket)
      const first = attachAbducoAgent({ label: 'legacy', socketPath: socket, sizeNeutral: true })
      let out = ''
      first.onFrame((frame) => {
        out += Buffer.from(frame.data).toString()
      })
      try {
        await first.ready
        first.writeBytes(Buffer.from('hello\n'))
        await waitFor(() => out.includes('ROUND:hello SIZE:25 80'))
        first.resize(133, 44)
        first.writeBytes(Buffer.from('sized\n'))
        await waitFor(() => out.includes('ROUND:sized SIZE:44 133'))
        first.dispose()
        process.kill(pid, 0)
        const located = await createDurableProcess().locate('unused', {
          ABDUCO_SOCKET_DIR: root,
          HOME: root,
        })
        expect(located).toBeUndefined()
        const again = attachAbducoAgent({ label: 'legacy', socketPath: socket, sizeNeutral: true })
        let next = ''
        let exitCode: number | undefined
        again.onFrame((frame) => {
          next += Buffer.from(frame.data).toString()
        })
        again.onExit((code) => {
          exitCode = code
        })
        try {
          await again.ready
          again.writeBytes(Buffer.from('again\n'))
          await waitFor(() => next.includes('ROUND:again SIZE:44 133'))
          again.writeBytes(Buffer.from('exit\n'))
          await waitFor(() => exitCode !== undefined)
          expect(exitCode).toBe(23)
        } finally {
          again.dispose()
        }
      } finally {
        first.dispose()
        try {
          process.kill(pid, 'SIGTERM')
        } catch {
          /* already exited */
        }
      }
    }, 15000)
  })
}
