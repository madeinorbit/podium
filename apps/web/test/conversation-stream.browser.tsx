/** Identical fixture copied into the untouched legacy revision by the runner. */
import type { TranscriptItem } from '@podium/model/browser'
import { asSessionId, asUserId } from '@podium/model/browser'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider } from '@podium/client-core/react'
import { createRoot } from 'react-dom/client'
import { attachWorklistPool } from '../src/app/store-worklist-pool'
import { ChatView } from '../src/features/chat/ChatView'
import { createHeaderFixture } from './header-fixture'
import '../src/index.css'
import '../src/styles.css'

const fixture = createHeaderFixture(20)
const id = asSessionId('synthetic-session-0')
// Cursorless items are supported by both owners; neither trims the requested
// 2,000-message corpus to its ordinary native-cursor following window.
let items: TranscriptItem[] = Array.from({ length: 2000 }, (_, index) => ({
  id: `stream-${index}`, role: index % 2 ? 'assistant' : 'user', answer: index % 2 === 1,
  text: index % 2 ? `Reply ${index}. **Structured prose** with a small \`code\` sample.` : `Question ${index}: explain the next step.`,
  ts: new Date(1_700_000_000_000 + index * 1000).toISOString(),
}))
const listeners = new Set<(items: TranscriptItem[], meta: { reset: boolean }) => void>()
const errors: string[] = []
let maxWindow = 0
Object.assign(fixture.api, {
  messages: { records: { query: async () => ({ records: [] }) } },
  sessions: { transcriptRead: { query: async () => ({ items, hasMore: false }) } },
})
const root = createRoot(document.getElementById('root')!)
document.documentElement.classList.add('dark')
document.body.style.margin = '0'
root.render(<StoreProvider
  principal={asClientPrincipal(asUserId('stream-operator'))}
  config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
  api={fixture.api} networkEnabled={false}
  createReplicaFn={() => {
    const replica = fixture.newReplica()
    replica.putTranscriptWindow(id, items)
    const write = replica.putTranscriptWindow.bind(replica)
    replica.putTranscriptWindow = (key, next) => { maxWindow = Math.max(maxWindow, next.length); write(key, next) }
    return replica
  }}
  onFatalError={error => errors.push(error)}
  attachRuntime={runtime => {
    fixture.bindHub(runtime.hub)
    fixture.publishMachines()
    runtime.hub.subscribeTranscript = (_id, _since, listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }
    return attachWorklistPool(runtime, error => errors.push(error.message))
  }}>
  <main style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}>
    <ChatView sessionId={id} />
  </main>
</StoreProvider>)

const driver = {
  ready: () => listeners.size > 0 && document.querySelector('[data-row-key="stream-1999"]') !== null,
  errors: () => [...errors],
  corpus: () => ({ messages: items.length, retained: maxWindow, visibleRows: document.querySelectorAll('[data-row-key]').length }),
  async run(durationMs = 30_000) {
    const started = performance.now()
    const sent = new Map<string, number>()
    const latencies: { atMs: number; latencyMs: number }[] = []
    const last = '[data-row-key="stream-1999"] .chat-md'
    const observer = new MutationObserver(() => {
      const match = document.querySelector(last)?.textContent?.match(/STREAM_TOKEN_(\d+)/)
      const stamp = match && sent.get(match[0])
      if (stamp === undefined || stamp === null) return
      sent.delete(match![0])
      latencies.push({ atMs: stamp - started, latencyMs: performance.now() - stamp })
    })
    observer.observe(document.getElementById('root')!, { childList: true, characterData: true, subtree: true })
    let seq = 0
    const emit = (frame: TranscriptItem[]) => { for (const listener of listeners) listener(frame, { reset: false }) }
    const timer = setInterval(() => {
      const token = `STREAM_TOKEN_${++seq}`
      const tail = { ...items.at(-1)!, text: `Streamed **reply** ${token}. A stable Markdown body with \`code\`.` }
      items = [...items.slice(0, -1), tail]
      sent.set(token, performance.now())
      emit([tail])
    }, 100)
    // A 2,000-item catch-up overlaps continued stream intake at 10 seconds.
    const catchup = setTimeout(() => {
      items = items.map((item, index) => index === 1999 ? item : { ...item, text: `${item.text}\n\nCatch-up revision.` })
      emit(items)
    }, 10_000)
    await new Promise(resolve => setTimeout(resolve, durationMs))
    clearInterval(timer); clearTimeout(catchup)
    await new Promise(resolve => setTimeout(resolve, 200))
    observer.disconnect()
    return { durationMs, sent: seq, shown: latencies.length, latencies, corpus: driver.corpus(), errors: driver.errors() }
  },
  close: () => root.unmount(),
}
Object.assign(window, { __conversationStream: driver })
declare global { interface Window { __conversationStream: typeof driver } }
