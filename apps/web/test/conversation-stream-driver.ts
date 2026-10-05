import type { TranscriptItem } from '@podium/model/browser'
import { asSessionId } from '@podium/model/browser'
import { createHeaderFixture } from './header-fixture'

export type RenderWork = { frame: number; row: number; composer: number; shell: number }
const emptyWork = (): RenderWork => ({ frame: 0, row: 0, composer: 0, shell: 0 })
globalThis.__chatRenderWork = emptyWork()

/** Both revisions receive identical rows, transport frames and catch-up data. */
export function createStreamFixture() {
  const fixture = createHeaderFixture(20)
  const id = asSessionId('synthetic-session-0')
  let items: TranscriptItem[] = Array.from({ length: 2000 }, (_, index) => ({
    id: `stream-${index}`, role: index % 2 ? 'assistant' : 'user', answer: index % 2 === 1,
    text: index % 2 ? `Reply ${index}. **Structured prose** with a small \`code\` sample.` : `Question ${index}: explain the next step.`,
    ts: new Date(1_700_000_000_000 + index * 1000).toISOString(),
  }))
  const listeners = new Set<(items: TranscriptItem[], meta: { reset: boolean }) => void>()
  const errors: string[] = []
  let retained = 0
  Object.assign(fixture.api, {
    messages: { records: { query: async () => ({ records: [] }) } },
    sessions: { transcriptRead: { query: async () => ({ items, hasMore: false }) } },
  })
  return {
    fixture, id, errors, listeners,
    replica() {
      const replica = fixture.newReplica()
      replica.putTranscriptWindow(id, items)
      retained = items.length
      const write = replica.putTranscriptWindow.bind(replica)
      replica.putTranscriptWindow = (key, next) => { retained = next.length; write(key, next) }
      return replica
    },
    corpus: () => ({ messages: items.length, retained, visibleRows: document.querySelectorAll('[data-row-key]').length }),
    emit(seq: number) {
      const tail = { ...items.at(-1)!, text: `${items.at(-1)!.text} STREAM_TOKEN_${seq}` }
      items = [...items.slice(0, -1), tail]
      for (const listener of listeners) listener([tail], { reset: false })
    },
    catchup() {
      items = items.map((item, index) => index === 1999 ? item : { ...item, text: `${item.text}\n\nCatch-up revision.` })
      for (const listener of listeners) listener(items, { reset: false })
    },
  }
}
const paint = () => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())))
export function installStreamDriver(source: ReturnType<typeof createStreamFixture>, close: () => void) {
  const driver = {
    ready: () => source.listeners.size > 0 && !!document.querySelector('[data-row-key="stream-1999"]'),
    async run(durationMs = 30_000) {
      const started = performance.now()
      const sent = new Map<string, number>()
      const latencies: { atMs: number; domMs: number; latencyMs: number }[] = []
      const typing: { atMs: number; latencyMs: number; retained: boolean }[] = []
      const checkpoints: { atMs: number; work: RenderWork }[] = []
      globalThis.__chatRenderWork = emptyWork()
      const field = document.querySelector<HTMLTextAreaElement>('textarea')!
      if (!field || field.disabled) throw new Error('A live composer is required')
      let keyStamp: number | null = null
      const keydown = (event: KeyboardEvent) => { if (event.key.length === 1) keyStamp = event.timeStamp }
      const input = async (event: Event) => {
        const stamp = keyStamp ?? event.timeStamp
        keyStamp = null
        const value = field.value
        await paint()
        typing.push({ atMs: stamp - started, latencyMs: performance.now() - stamp, retained: field.value === value })
      }
      field.addEventListener('input', input)
      field.addEventListener('keydown', keydown)
      const observer = new MutationObserver(() => {
        const tokens = document.querySelector('[data-row-key="stream-1999"]')?.textContent?.match(/STREAM_TOKEN_\d+/g)
        const token = tokens?.at(-1)
        const stamp = token ? sent.get(token) : undefined
        if (stamp === undefined) return
        sent.delete(token!)
        const domMs = performance.now() - stamp
        void paint().then(() => latencies.push({ atMs: stamp - started, domMs, latencyMs: performance.now() - stamp }))
      })
      observer.observe(document.getElementById('root')!, { childList: true, characterData: true, subtree: true })
      let seq = 0
      const timer = setInterval(() => {
        sent.set(`STREAM_TOKEN_${++seq}`, performance.now())
        source.emit(seq)
      }, 100)
      const checkpoint = setInterval(() => checkpoints.push({ atMs: performance.now() - started, work: { ...globalThis.__chatRenderWork } }), 1000)
      const catchup = setTimeout(() => source.catchup(), 10_000)
      await new Promise(done => setTimeout(done, durationMs))
      clearInterval(timer); clearInterval(checkpoint); clearTimeout(catchup)
      await new Promise(done => setTimeout(done, 200))
      observer.disconnect(); field.removeEventListener('input', input); field.removeEventListener('keydown', keydown)
      return { durationMs, elapsedMs: performance.now() - started, sent: seq, shown: latencies.length,
        latencies, typing, checkpoints, work: { ...globalThis.__chatRenderWork }, corpus: source.corpus(), errors: [...source.errors] }
    },
    close,
  }
  Object.assign(window, { __conversationStream: driver })
  return driver
}
declare global {
  var __chatRenderWork: RenderWork
  interface Window { __conversationStream: ReturnType<typeof installStreamDriver> }
}
