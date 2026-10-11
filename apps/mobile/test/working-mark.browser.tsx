/** Real phone surfaces over a small synthetic pool, with no backend or agent. */
import { StoreProvider } from '@podium/client-core/react'
import { asClientPrincipal } from '@podium/client-core/principal'
import { sessionCardModel } from '@podium/client-core/values'
import { asSessionId, asUserId } from '@podium/model/browser'
import { worklistView } from '@podium/client-graph/worklist/view-model'
import { here } from '@podium/client-graph/lookup'
import { observer } from 'mobx-react-lite'
import { createRoot } from 'react-dom/client'
import { attachMobilePool, useMobilePool } from '../src/client/mobile-pool'
import { useSessionContextSession } from '../src/client/use-session-context'
import { SessionCard } from '../src/components/SessionCard'
import { SessionConversation } from '../src/components/SessionConversation'
import { TranscriptList } from '../src/components/TranscriptList'
import { IdSquare } from '../src/components/IdSquare'
import { useWorkingMarkMotion } from '../src/components/working-mark-motion.web'
import { WorkRow } from '../src/screens/WorkListRow'
import { createHeaderFixture } from '../../web/test/header-fixture'
import type { MobileTrpc } from '../src/client/trpc'

const fixture = createHeaderFixture(4)
const id = asSessionId('synthetic-session-0')
const pendingId = asSessionId('synthetic-session-1')
const since = new Date().toISOString()
fixture.patch('session', id, { title: 'Tetra animation', agentState: { phase: 'working', since } })
fixture.patch('session', pendingId, { title: 'New working session', agentState: { phase: 'working', since } })
fixture.patch('issueProjection', 'synthetic-0', { title: 'Phone working mark' })
const items = [
  { id: 'question', role: 'user' as const, text: 'Keep the same working state on my phone.', ts: since },
  { id: 'reply', role: 'assistant' as const, answer: true, text: 'The phone now shows the tumbling tetrahedron in its working blue.', ts: since },
]
Object.assign(fixture.api, {
  sessions: { transcriptRead: { query: async ({ sessionId }: { sessionId: string }) => ({ items: sessionId === id ? items : [], hasMore: false }) } },
  messages: { records: { query: async () => ({ records: [] }) } },
})
const Surface = observer(function Surface() {
  useWorkingMarkMotion()
  const pool = useMobilePool()
  const session = useSessionContextSession(id)
  const pending = useSessionContextSession(pendingId)
  if (!pool || !session || !pending) return null
  const issue = here(pool.issue('synthetic-0'))
  const row = issue ? worklistView(pool).row(issue) : undefined
  return <main>
    <section data-shot="rows"><h2>WORK ROW · WORKING</h2>
      {row && <WorkRow row={row} navPending={false} onOpen={() => {}} onLongPress={() => {}} />}
      <div style={{ padding: '12px 18px', display: 'flex', gap: 16, alignItems: 'center' }}>
        <IdSquare issue={{ seq: 1000, displayRef: 'SYN-1000' }} state="working" badge={{ kind: 'working' }} />
        <span style={{ color: '#aaa', fontSize: 12 }}>Working badge · 9 px</span>
      </div>
    </section>
    <section data-shot="card"><h2>SESSION CARD · WORKING</h2>
      <SessionCard model={sessionCardModel(session, undefined)} session={session} onPress={() => {}} />
    </section>
    <section data-shot="transcript"><h2>TRANSCRIPT · WORKING</h2><div className="feed">
      <TranscriptList items={items} transcriptQuestion={null} live onAnswer={async () => {}}
        pendingTurns={[{ id: 'pending-message', text: 'Please keep going.', delivery: 'sent' }]}
        tail={{ label: 'Working', tone: 'working', since }} />
    </div></section>
    <section data-shot="pending"><h2>EMPTY TRANSCRIPT · AGENT COMPUTING</h2><div className="pending">
      <SessionConversation session={pending} issue={undefined} />
    </div></section>
  </main>
})
const root = createRoot(document.getElementById('root')!)
root.render(<StoreProvider principal={asClientPrincipal(asUserId('operator'))}
  config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
  api={fixture.api as unknown as MobileTrpc} networkEnabled={false}
  createReplicaFn={() => { const replica = fixture.newReplica(); replica.putTranscriptWindow(id, items); return replica }}
  attachRuntime={runtime => { fixture.bindHub(runtime.hub); fixture.publishMachines(); return attachMobilePool(runtime, error => { throw error }) }}>
  <Surface />
</StoreProvider>)
