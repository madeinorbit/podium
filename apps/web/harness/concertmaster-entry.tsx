// The Concertmaster's curated chat and its "Needs you" list in the shipping
// materials (POD-7211): the ask card in every state, between the agent's
// messages and the person's card.
// bun --bun x vite --config vite.harness.config.ts
// /harness/concertmaster.html?theme=light|dark&width=760|390&view=chat|dock
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import type { ConcertmasterEntryModel } from '@podium/client-graph/models'
import { createRoot } from 'react-dom/client'
import {
  ConcertmasterAskCard,
  type RespondToAsk,
} from '@/features/chat/concertmaster/ConcertmasterAskCard'
import '@/index.css'
import '@/styles.css'

const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = 'podium'
document.documentElement.classList.toggle('dark', params.get('theme') === 'dark')
const dock = params.get('view') === 'dock'
const width = Number(params.get('width') ?? (dock ? 360 : 760))

const at = (minute: number): string => `2026-11-20T09:${String(minute).padStart(2, '0')}:00.000Z`
const ask = (over: Record<string, unknown>): ConcertmasterEntryModel =>
  ({
    id: `s1\n${String(over.number)}`,
    entryId: String(over.number),
    sessionId: 's1',
    kind: 'ask',
    createdAt: at(10),
    status: 'open',
    open: (over.status ?? 'open') === 'open',
    isAsk: true,
    ...over,
  }) as unknown as ConcertmasterEntryModel

const decision = ask({
  number: 4,
  askKind: 'decision',
  body: 'Ship the new sidebar today?',
  detail: 'Tests are green on desktop. The phone layout has not been checked yet.',
  options: ['Ship today', 'Wait for the phone check'],
  createdAt: at(14),
})
const question = ask({
  number: 5,
  askKind: 'question',
  body: 'Which database should the reporting service use?',
  options: ['Postgres', 'SQLite'],
  createdAt: at(21),
})
const todo = ask({
  number: 6,
  askKind: 'todo',
  body: 'Rotate the staging API key',
  detail: 'The current key expires on Friday; only you can mint a new one.',
  createdAt: at(22),
})
const answered = ask({
  number: 2,
  askKind: 'decision',
  body: 'Keep the old export format for one more release?',
  status: 'answered',
  answer: 'Yes, one more release',
  settledBy: 'user',
  settledAt: at(8),
})
const withdrawn = ask({
  number: 3,
  askKind: 'question',
  body: 'Do you still want the nightly digest?',
  status: 'retracted',
  answer: 'You answered this in chat.',
  settledBy: 'agent',
  settledAt: at(9),
})

const respond: RespondToAsk = () => new Promise((resolve) => setTimeout(() => resolve(true), 600))

function Said({ children, time }: { children: string; time: string }) {
  return (
    <div className="transcript-row cm-said">
      <div className="transcript-body">
        <div className="chat-md">
          <p>{children}</p>
        </div>
        <div className="msg-foot" data-side="left">
          <time className="chat-clk">{time}</time>
        </div>
      </div>
    </div>
  )
}

function You({ children, time }: { children: string; time: string }) {
  return (
    <div className="transcript-row transcript-turn-open">
      <div className="transcript-body transcript-you">
        <div className="transcript-you-bubble">
          <div className="transcript-you-body">
            <div className="chat-md">
              <p>{children}</p>
            </div>
          </div>
        </div>
        <div className="msg-foot" data-side="right">
          <time className="chat-clk">{time}</time>
        </div>
      </div>
    </div>
  )
}

function Row({ entry }: { entry: ConcertmasterEntryModel }) {
  return (
    <div className="transcript-row cm-ask-row">
      <div className="transcript-body">
        <ConcertmasterAskCard entry={entry} onRespond={respond} />
      </div>
    </div>
  )
}

function Chat() {
  return (
    <div className="bg-card px-8 pt-6 pb-4" data-testid="scene">
      <div className="transcript-daymark">
        <span className="transcript-daymark-label">Today</span>
      </div>
      <You time="10:02">Take over the sidebar rework and keep me posted.</You>
      <Said time="10:06">
        On it. Two agents are on the layout and the tests; I will tell you when there is something
        to look at.
      </Said>
      <Row entry={answered} />
      <Row entry={withdrawn} />
      <Said time="10:14">The rework is merged on the branch and the desktop tests pass.</Said>
      <Row entry={decision} />
      <Row entry={question} />
      <Row entry={todo} />
    </div>
  )
}

function Dock() {
  return (
    <div className="flex flex-col gap-2 bg-engraved px-[18px] pt-3 pb-5" data-testid="scene">
      <div className="flex items-baseline gap-2 text-[11.5px]">
        <span className="font-semibold text-muted-foreground">Needs you</span>
        <span className="text-text-faint tabular-nums">3</span>
        <span className="flex-1" />
        <span className="text-text-dim">Settled · 2</span>
      </div>
      {[decision, question, todo].map((entry) => (
        <ConcertmasterAskCard key={entry.id} entry={entry} dock onRespond={respond} />
      ))}
      <div className="flex flex-col gap-1.5 border-t border-hairline-soft pt-2">
        {[answered, withdrawn].map((entry) => (
          <ConcertmasterAskCard key={entry.id} entry={entry} dock onRespond={respond} />
        ))}
      </div>
    </div>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <main style={{ width: `${width}px` }}>{dock ? <Dock /> : <Chat />}</main>,
)
