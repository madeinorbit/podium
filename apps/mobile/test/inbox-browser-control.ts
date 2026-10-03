/** Complete Inbox browser census must reject a legacy reader at enabled mount.
 * Flatblock only; all synthetic data. Restore the planted production hook. */
import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'

if (hostname() !== 'flatblock') throw new Error('Inbox control belongs on flatblock')
const controls = [
  [
    'complete Inbox legacy hook',
    'apps/mobile/src/client/use-inbox-data.ts',
    'export function useInboxData(): InboxData {',
    "import { useStoreSelector } from '@podium/client-core/react'; export function useInboxData(): InboxData { useStoreSelector(s => s.sessions)",
    'Legacy work at enabled mount',
  ],
  [
    'real launch sibling',
    'apps/mobile/vite.inbox.config.ts',
    "const complete = process.env.PODIUM_INBOX_COMPLETE === '1'",
    'const complete = false',
    'Complete Inbox did not mount the real launch button',
  ],
] as const
for (const [control, path, needle, fault, expected] of controls) {
  const original = await readFile(path, 'utf8')
  if (original.indexOf(needle) < 0 || original.indexOf(needle) !== original.lastIndexOf(needle))
    throw new Error(`Ambiguous complete Inbox control: ${control}`)
  try {
    await writeFile(path, original.replace(needle, fault))
    const run = spawnSync(
      'bun',
      ['apps/mobile/test/inbox-proof.ts', '--complete', '--counts-only'],
      { encoding: 'utf8', timeout: 600000, env: process.env },
    )
    const output = `${run.stdout}\n${run.stderr}`
    if (run.error || run.status === 0 || !output.includes(expected)) {
      console.error(output)
      throw new Error('Complete Inbox census did not reject the planted legacy hook')
    }
    console.log(JSON.stringify({ control, observedRed: true }))
  } finally {
    await writeFile(path, original)
  }
}
