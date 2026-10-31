/**
 * NOTES BESIDE TOOL RUNS, PHOTOGRAPHED (POD-2234).
 *
 * Mail rows and tool runs are both quiet rows in the feed, and whether they read
 * as one family — and how tightly a run of them packs — is entirely CSS that
 * jsdom never applies. This mounts the shipping `MessageEnvelopeGroup` and
 * `InboxReadRow` between static work lines (the markup `ToolBatchView` renders,
 * without its run model) inside the transcript window's row shells, so the
 * sibling spacing rules see the same DOM as the feed.
 */
import type { ParsedEnvelope } from '@podium/client-core/values'
import { ChevronDown } from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider } from '@/app/theme'
import { InboxReadRow } from '@/features/chat/MailCommandRow'
import { MessageEnvelopeGroup } from '@/features/chat/MessageEnvelopeGroup'
import '@/index.css'
import '@/styles.css'

const note = (id: string, from: string, body: string, extra: Partial<ParsedEnvelope> = {}) =>
  ({
    id,
    from,
    to: 'issue:PIPP-380',
    body,
    question: false,
    expectsReply: false,
    ...extra,
  }) satisfies ParsedEnvelope

const READY = note(
  'msg_1',
  'issue:PIPP-386',
  'Settings UI (PIPP-386) ready for integration.\nBranch issue/386-agent-connections-settings-page, on top of 5d840849: c0ea3d98 (page), 85d1b445 (contract defaults), 787468e9 (interface-review fixes + 384 API details), and a follow-up for the empty state.',
)
const ASK = note(
  'msg_2',
  'issue:PIPP-384',
  'Should the API details panel default to collapsed?\nThe 384 contract leaves it open; the settings page assumes closed.',
  { question: true },
)

function Shell({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div data-transcript-row="" style={{ display: 'flow-root', position: 'relative' }}>
      {children}
    </div>
  )
}

function Prose({ text }: { text: string }): JSX.Element {
  return (
    <Shell>
      <div className="transcript-row">
        <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
        <div className="transcript-body">
          <div className="chat-md">
            <p>{text}</p>
          </div>
        </div>
      </div>
    </Shell>
  )
}

function Tools({ phrase, time }: { phrase: string; time?: string }): JSX.Element {
  return (
    <Shell>
      <div className="transcript-row">
        <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
        <div className="transcript-body">
          <div className="work-line" data-state="done" data-open="false">
            <button data-pressable type="button" className="work-line-row">
              <span className="work-line-glyph" aria-hidden="true">
                ✓
              </span>
              <span className="work-line-phrase">{phrase}</span>
              {time && <span className="work-line-time">{time}</span>}
              <ChevronDown className="work-line-chev" size={11} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </Shell>
  )
}

function Notes({ envelopes, ts }: { envelopes: ParsedEnvelope[]; ts: string }): JSX.Element {
  return (
    <Shell>
      <MessageEnvelopeGroup
        envelopes={envelopes}
        className="transcript-row"
        ts={ts}
        onBodyClick={() => {}}
      />
    </Shell>
  )
}

function Harness(): JSX.Element {
  return (
    <ThemeProvider>
      <div className="bg-background p-6" data-testid="feed">
        <div className="mx-auto max-w-[720px]">
          <Prose text="Wiring the settings page into the panel." />
          <Tools phrase="Read 4 files" />
          <Notes envelopes={[READY]} ts="2026-10-28T22:17:00Z" />
          <Notes envelopes={[ASK]} ts="2026-10-28T22:18:00Z" />
          <Shell>
            <InboxReadRow
              notes={2}
              result="msg_1 from PIPP-386\nmsg_2 from PIPP-384"
              className="transcript-row"
              blockIndex={0}
              rowKey="inbox"
              ts="2026-10-28T22:18:30Z"
            />
          </Shell>
          <Tools phrase="Ran 2 commands" time="0:14" />
          <Prose text="Both branches are in; merging now." />
        </div>
      </div>
    </ThemeProvider>
  )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<Harness />)
