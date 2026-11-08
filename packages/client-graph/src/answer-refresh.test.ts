import type { TopicListener } from '@podium/client-core/socket-transport'
import { expect, it, vi } from 'vitest'
import { AnswerRefresh, topicRefresh } from './answer-refresh'
import { GitView } from './git-view'

const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}
it('coalesces changes during an in-flight answer, reads the final edit, and releases on close', async () => {
  let changed!: () => void
  let finish!: () => void
  const stop = vi.fn()
  const read = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          finish = done
        }),
    )
    .mockResolvedValue(undefined)
  const owner = new AnswerRefresh(read, (notify) => {
    changed = notify
    return stop
  })
  owner.open()
  await settle()
  changed()
  changed()
  changed()
  expect(read).toHaveBeenCalledTimes(1)
  finish()
  await settle()
  expect(read).toHaveBeenCalledTimes(2)
  owner.close()
  changed()
  await settle()
  expect(read).toHaveBeenCalledTimes(2)
  expect(stop).toHaveBeenCalledTimes(1)
})
it('git answers refetch on a version change, preserve the selected file, and unsubscribe on close', async () => {
  let listener!: TopicListener
  const release = vi.fn()
  const subscribeTopic = vi.fn((_kind, _id, value) => {
    listener = value
    return release
  })
  const ports = {
    gitStatus: vi.fn(async () => ({ ok: true, output: '## main\n M file.ts\n' })),
    gitDiffFile: vi.fn(async () => ({ ok: true, output: '' })),
    readFileScoped: vi.fn(),
    refreshSignal: topicRefresh({ subscribeTopic } as never, 'checkout.changed', 'machine:/repo'),
  }
  const view = new GitView('/repo', undefined, ports)
  view.open()
  await settle()
  const entry = view.reviewStatus!.entries[0]!
  view.toggleFile(entry)
  await settle()
  listener.onState?.({ status: 'value', value: null, position: { epoch: 'e', seq: 1 } })
  await settle()
  expect(ports.gitStatus).toHaveBeenCalledTimes(2)
  expect(ports.gitDiffFile).toHaveBeenCalledTimes(2)
  expect(view.openPath).toBe('file.ts')
  listener.onState?.({ status: 'value', value: null, position: { epoch: 'e', seq: 1 } })
  await settle()
  expect(ports.gitStatus).toHaveBeenCalledTimes(2)
  view.close()
  expect(release).toHaveBeenCalledTimes(1)
  listener.onState?.({ status: 'value', value: null, position: { epoch: 'e', seq: 2 } })
  await settle()
  expect(ports.gitStatus).toHaveBeenCalledTimes(2)
})
