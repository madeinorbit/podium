import { asSessionId, type MessageRecordWire, type TranscriptItem } from '@podium/model'
import { autorun, configure, isObservable, reaction } from 'mobx'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Sends } from './sends'
import { TranscriptLog } from './transcript-log'

const id = asSessionId('chat')
const row = (
  key: string,
  text: string,
  role: TranscriptItem['role'] = 'assistant',
): TranscriptItem => ({ id: key, text, role, cursor: key })
const cleanup: (() => void)[] = []
afterEach(() => {
  for (const stop of cleanup.splice(0)) stop()
  configure({ enforceActions: 'observed' })
})

function log(items: TranscriptItem[] = []) {
  const source = {
    read: vi.fn(async () => ({ items, hasMore: false })),
    subscribe: vi.fn(() => vi.fn()),
  }
  const model = new TranscriptLog({
    sessionId: id,
    source,
    cache: { read: () => ({ items, savedAt: 12 }), write: vi.fn() },
  })
  cleanup.push(() => model.dispose())
  return { model, source }
}

describe('conversation observation boundaries', () => {
  it('keeps items and nested payloads frozen and outside MobX', () => {
    const item = { ...row('a', 'partial'), tags: [{ kind: 'file' as const, label: 'a.ts' }] }
    const { model } = log([item])
    expect(isObservable(model.ids)).toBe(true)
    expect(isObservable(model.byId)).toBe(true)
    expect(model.byId.get('a')).toBe(item)
    expect(isObservable(item)).toBe(false)
    expect(isObservable(item.tags)).toBe(false)
    expect(Object.isFrozen(item)).toBe(true)
    expect(Object.isFrozen(item.tags)).toBe(true)
    expect(Object.isFrozen(item.tags[0])).toBe(true)
  })

  it('replaces only the addressed row without notifying ids or another row', () => {
    configure({ enforceActions: 'always' })
    const { model } = log([row('a', 'first'), row('b', 'partial')])
    const order = vi.fn(),
      first = vi.fn(),
      last = vi.fn()
    cleanup.push(
      reaction(() => model.ids.slice(), order),
      reaction(() => model.byId.get('a'), first),
      reaction(() => model.byId.get('b'), last),
    )
    const incoming = row('b', 'complete')
    model.merge([incoming])
    expect(model.ids.slice()).toEqual(['a', 'b'])
    expect(model.byId.get('b')).toBe(incoming)
    expect(order).not.toHaveBeenCalled()
    expect(first).not.toHaveBeenCalled()
    expect(last).toHaveBeenCalledTimes(1)
    expect(isObservable(incoming)).toBe(false)
    model.merge([{ ...incoming }])
    expect(last).toHaveBeenCalledTimes(1)
  })

  it('seeds cached messages synchronously before starting any network read', () => {
    const { model, source } = log([row('cached', 'offline text')])
    expect(source.read).not.toHaveBeenCalled()
    expect(model.ids.slice()).toEqual(['cached'])
    expect(model.byId.get('cached')?.text).toBe('offline text')
  })

  it('retires sends atomically with their transcript entry and keeps pending plain', () => {
    const record: MessageRecordWire = {
      id: 'sent',
      sessionId: id,
      senderUserId: 'operator',
      body: 'prompt',
      createdAt: '2026-10-05T10:00:00Z',
      status: 'confirmed',
      transcriptItem: { id: 'native', cursor: 'native' },
    }
    let sends: Sends | undefined
    const transcript = new TranscriptLog({
      sessionId: id,
      source: { read: async () => ({ items: [], hasMore: false }), subscribe: () => () => {} },
      onChange: (change) => sends?.reconcile(change),
    })
    sends = new Sends({
      sessionId: id,
      transcript,
      drafts: { get: () => '', set: () => {} },
      readContext: () => ({ canInterrupt: true }),
      records: { getSnapshot: () => [record], subscribe: () => () => {} },
      initialPending: [
        {
          id: 'local',
          deliveryId: 'sent',
          text: 'prompt',
          wire: 'prompt',
          at: 1,
          state: 'sent',
          kind: 'message',
        },
      ],
      createDeliveryId: () => 'next',
      deliver: async () => ({ state: 'sent' }),
    })
    cleanup.push(() => {
      sends?.dispose()
      transcript.dispose()
    })
    sends.start()
    expect(isObservable(sends.pending[0])).toBe(false)
    expect(Object.isFrozen(sends.pending[0])).toBe(true)
    const paints: { items: string[]; bubbles: string[] }[] = []
    cleanup.push(
      autorun(() => {
        paints.push({
          items: transcript.ids.slice(),
          bubbles: sends!.bubbles.map((bubble) => bubble.deliveryId),
        })
      }),
    )
    transcript.merge([row('native', 'rewritten prompt', 'user')])
    expect(paints).toEqual([
      { items: [], bubbles: ['sent'] },
      { items: ['native'], bubbles: [] },
    ])
    expect(sends.pending).toHaveLength(0)
  })

  it('counts duplicate native ids once when retiring next-user-item sends', () => {
    let sends: Sends | undefined
    const transcript = new TranscriptLog({
      sessionId: id,
      source: { read: async () => ({ items: [], hasMore: false }), subscribe: () => () => {} },
      onChange: (change) => sends?.reconcile(change),
    })
    sends = new Sends({
      sessionId: id,
      transcript,
      drafts: { get: () => '', set: () => {} },
      readContext: () => ({ canInterrupt: false }),
      initialPending: ['one', 'two'].map((key) => ({
        id: key,
        deliveryId: key,
        text: key,
        wire: key,
        at: 1,
        state: 'queued',
        kind: 'message',
        reconcile: 'next-user-item',
      })),
      reconcile: 'next-user-item',
      createDeliveryId: () => 'next',
      deliver: async () => {},
    })
    cleanup.push(() => {
      sends?.dispose()
      transcript.dispose()
    })
    sends.start()
    transcript.merge([row('native', 'partial', 'user'), row('native', 'complete', 'user')])
    expect(transcript.ids.slice()).toEqual(['native'])
    expect(sends.pending.map((turn) => turn.deliveryId)).toEqual(['two'])
  })

  it('keeps captured send actions inert after disposal without rearming a timer', async () => {
    const { model: transcript } = log()
    const deliver = vi.fn(async () => {
      throw new Error('offline')
    })
    const discard = vi.fn(async () => {})
    const dismissOffer = vi.fn(async () => {})
    const interrupt = vi.fn(async () => {})
    const setDraft = vi.fn()
    const setTimer = vi.fn(() => 1)
    const clearTimer = vi.fn()
    const sends = new Sends({
      sessionId: id,
      transcript,
      drafts: { get: () => '', set: setDraft },
      readContext: () => ({ canInterrupt: true }),
      createDeliveryId: () => 'pending',
      deliver,
      discard,
      dismissOffer,
      interrupt,
      clock: { now: () => 1, setTimeout: setTimer, clearTimeout: clearTimer },
    })
    cleanup.push(() => sends.dispose())
    sends.start()
    await sends.submit({ text: 'first' })
    expect(sends.pending[0]?.state).toBe('failed')
    sends.dispose()
    deliver.mockClear()
    setTimer.mockClear()
    setDraft.mockClear()
    await sends.retry('pending-1')
    expect(await sends.submit({ text: 'after sign-out' })).toBeNull()
    expect(await sends.sendOffer('after sign-out', 'old')).toBeNull()
    await sends.discard('pending-1')
    await sends.dismissOffer('old')
    expect(await sends.interrupt()).toBe(false)
    sends.setDraft('after sign-out')
    expect(deliver).not.toHaveBeenCalled()
    expect(discard).not.toHaveBeenCalled()
    expect(dismissOffer).not.toHaveBeenCalled()
    expect(interrupt).not.toHaveBeenCalled()
    expect(setDraft).not.toHaveBeenCalled()
    expect(setTimer).not.toHaveBeenCalled()
    expect(clearTimer).toHaveBeenCalled()
  })

  it('makes echo membership reactive without a transcript scan', () => {
    const { model } = log([row('echo', 'typed prompt', 'user')])
    const answer = vi.fn()
    cleanup.push(reaction(() => model.hasUserEcho('typed prompt'), answer))
    model.merge([row('echo', 'changed prompt', 'user')])
    expect(answer).toHaveBeenCalledTimes(1)
    expect(model.hasUserEcho('typed prompt')).toBe(false)
    expect(model.hasUserEcho('changed prompt')).toBe(true)
  })
})
