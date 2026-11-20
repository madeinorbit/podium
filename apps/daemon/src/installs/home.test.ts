import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { podiumHomeId } from '@podium/protocol'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { HomeRegistry } from '../homes/registry'
import { inspectPodiumHome, removePodiumHome } from './home'

let root: string
let homes: HomeRegistry
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'harness-home-remove-'))
  homes = new HomeRegistry({ root: join(root, 'homes') })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
function conversation(id: string) {
  const home = homes.ensurePodiumHome('claude-code').home
  const file = join(home.dir, 'projects', '-repo', `${id}.jsonl`)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(
    file,
    [
      JSON.stringify({ type: 'summary', customTitle: `Conversation ${id}`, sessionId: id }),
      JSON.stringify({
        type: 'user',
        uuid: `${id}-u`,
        timestamp: '2026-11-20T00:00:00Z',
        cwd: '/repo',
        sessionId: id,
        message: { role: 'user', content: 'hello' },
      }),
    ].join('\n'),
  )
  return home
}
it('lists stored conversations and requires the exact confirmed set for a separate deletion', async () => {
  const home = conversation('first')
  const info = await inspectPodiumHome(homes, 'claude-code')
  expect(info.homeExists).toBe(true)
  expect(info.conversations).toHaveLength(1)
  expect(info.conversations[0]?.title).toContain('first')
  await expect(
    removePodiumHome(homes, 'claude-code', join(root, 'harnesses'), undefined),
  ).rejects.toThrow('confirm')
  conversation('second')
  await expect(
    removePodiumHome(
      homes,
      'claude-code',
      join(root, 'harnesses'),
      info.conversations.map((item) => item.id),
    ),
  ).rejects.toThrow('changed')
  expect(existsSync(home.dir)).toBe(true)
  const current = await inspectPodiumHome(homes, 'claude-code')
  await removePodiumHome(
    homes,
    'claude-code',
    join(root, 'harnesses'),
    current.conversations.map((item) => item.id),
  )
  expect(homes.get(podiumHomeId('claude-code'))).toBeUndefined()
})
