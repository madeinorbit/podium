import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import type { SessionOffer } from '@podium/model/browser'
import { createRoot } from 'react-dom/client'
import { OfferBar } from '@/features/chat/OfferBar'
import { TipHost } from '@/features/tips'
import { MemoryTipLog } from '@/features/tips/memory-tip-log'
import { WorkRowShell } from '@/features/worklist/WorkRowShell'
import '@/index.css'
import '@/styles.css'

// First Flights moment 6 (first-offer): the real offer card and a real sidebar
// row, under a host with a fresh log. `?theme=dark`, `?card=2` advances to the row.
const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = 'podium'
document.documentElement.classList.toggle('dark', params.get('theme') === 'dark')

const offer: SessionOffer = {
  message:
    'Login screen ready to merge\nTests and the lean gate are green. Judge the two screenshots.',
  actions: [
    { label: 'Merge', prompt: 'Merge it' },
    { label: 'Send back', prompt: 'Send it back', input: true },
  ],
  createdAt: new Date(Date.now() - 4 * 60_000).toISOString(),
}
const session = { sessionId: 'harness', issueId: 'iss_login', lastInputAt: null } as never

function Row({
  id,
  label,
  word,
  active,
}: {
  id: string
  label: string
  word: string
  active: boolean
}) {
  return (
    <WorkRowShell
      testId="unified-issue-row"
      idLabel={id === 'iss_login' ? 'POD-12' : 'POD-11'}
      label={label}
      statusLine={<span>{word}</span>}
      tone={word === 'Needs you' ? 'needs' : 'idle'}
      phase={word === 'Needs you' ? 'waiting' : 'queued'}
      active={active}
      onSelect={() => {}}
      domMark={id}
    />
  )
}

function App() {
  return (
    <div className="flex h-screen bg-background font-sans text-foreground">
      <aside className="flex w-[260px] flex-none flex-col gap-0.5 border-r border-border bg-sidebar p-2">
        <Row id="iss_login" label="Login screen" word="Needs you" active />
        <Row id="iss_search" label="Make search feel instant" word="Planned" active={false} />
      </aside>
      <main className="flex min-w-0 flex-1 flex-col justify-end p-6">
        <div className="mx-auto w-full max-w-[720px] pb-[220px]">
          <OfferBar offer={offer} disabled={false} onAction={() => {}} session={session} />
        </div>
      </main>
    </div>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('Missing harness root')
createRoot(root).render(
  <TipHost log={new MemoryTipLog()}>
    <App />
  </TipHost>,
)
