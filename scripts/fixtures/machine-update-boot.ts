/** Real installer/control boundary with a deterministic parent-start completion barrier. */
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { MachineUpdateExecutor } from '../../packages/runtime/src/machine-update'
import { createHeadlessMachineUpdateAdapter } from '../../packages/runtime/src/machine-update-headless'
import { startMachineUpdateControl } from '../../packages/runtime/src/machine-update-control'

const root = process.argv[2]!
let releasePrepare: (() => void) | undefined
const adapter = createHeadlessMachineUpdateAdapter({
  installDir: join(root, 'payload'),
  runningVersion: '1.0.0',
  caps: ['update.delivery.feed'],
  platform: 'linux-x86_64',
  pinnedPubkey: () => readFileSync(join(root, 'update-key'), 'utf8'),
  readApplied: () => [],
  restart: async () => {
    process.send?.({ event: 'restart' })
    return 'handover-pending'
  },
})
const prepare = adapter.prepare.bind(adapter)
adapter.prepare = async (grant, signal, progress) => {
  process.send?.({ event: 'prepare' })
  const prepared = await prepare(grant, signal, progress)
  // Extraction and signature/digest verification above are production code. Hold
  // the result while startup completes, with the real shared staging populated.
  await new Promise<void>((resolve) => {
    releasePrepare = resolve
    signal.addEventListener('abort', () => resolve(), { once: true })
    if (signal.aborted) resolve()
    process.send?.({ event: 'staged' })
  })
  return prepared
}
const executor = new MachineUpdateExecutor({
  runtimeDir: join(root, 'runtime'),
  adapter,
  report: () => {},
})
await executor.recoverBeforeBoot()
const control = await startMachineUpdateControl(join(root, 'runtime'), executor)
process.on('message', async (message: { command: string; id: number }) => {
  if (message.command === 'boot') {
    const confirmation = executor.confirmBoot(true)
    // Admit a following no-op cancel to prove confirmation has reached and
    // released admission even while its returned promise waits for preparation.
    await executor.cancel('not-the-grant')
    process.send?.({ event: 'boot-admitted', id: message.id })
    await confirmation
    process.send?.({ event: 'boot-complete', id: message.id })
  } else if (message.command === 'release') {
    releasePrepare?.()
  } else if (message.command === 'close') {
    await control.close()
    process.exit(0)
  }
})
process.send?.({ event: 'ready' })
