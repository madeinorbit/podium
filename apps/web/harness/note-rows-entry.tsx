/**
 * NOTES BESIDE TOOL RUNS, PHOTOGRAPHED (POD-2234, POD-2286).
 *
 * Mail rows and tool runs are both quiet rows in the feed, and whether they read
 * as one family — and how tightly a run of them packs — is entirely CSS that
 * jsdom never applies. This mounts the shipping `MessageEnvelopeGroup` and
 * `InboxReadRow` between static work lines (the markup `ToolBatchView` renders,
 * without its run model) inside the transcript window's row shells, so the
 * sibling spacing rules see the same DOM as the feed.
 */
import type { ParsedEnvelope } from '@podium/client-core/values'
import type { TranscriptItem } from '@podium/model/browser'
import { ChevronDown } from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider } from '@/app/theme'
import type { ChatBlock } from '@/features/chat/chat'
import { InboxReadRow } from '@/features/chat/MailCommandRow'
import { MessageEnvelopeGroup } from '@/features/chat/MessageEnvelopeGroup'
import { ToolBlock } from '@/features/chat/ToolBlock'
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

function Notes({
  envelopes,
  ts,
  open = false,
}: {
  envelopes: ParsedEnvelope[]
  ts: string
  open?: boolean
}): JSX.Element {
  return (
    <Shell>
      <MessageEnvelopeGroup
        envelopes={envelopes}
        className="transcript-row"
        ts={ts}
        onBodyClick={() => {}}
        forceOpen={open}
      />
    </Shell>
  )
}

const bash = (id: string, command: string, ts: string, result: string): ChatBlock =>
  ({
    item: { id, role: 'tool', toolName: 'Bash', toolInput: command, ts, toolResult: result },
    result,
  }) as unknown as ChatBlock & { item: TranscriptItem }

/** An opened run: the list `ToolBatchView` renders under its line. */
function OpenTools({ phrase, blocks }: { phrase: string; blocks: ChatBlock[] }): JSX.Element {
  return (
    <Shell>
      <div className="transcript-row">
        <div className="transcript-rail transcript-rail--none" aria-hidden="true" />
        <div className="transcript-body">
          <div className="work-line" data-state="done" data-open="true">
            <button data-pressable type="button" className="work-line-row">
              <span className="work-line-glyph" aria-hidden="true">
                ✓
              </span>
              <span className="work-line-phrase">{phrase}</span>
              <span className="work-line-time">2:11</span>
              <ChevronDown className="work-line-chev" size={11} aria-hidden="true" />
            </button>
            <div className="work-line-list work-line-list--timed">
              {blocks.map((b) => (
                <ToolBlock
                  key={b.item.id}
                  block={b}
                  timed
                  sessionId={'s' as never}
                  cwd="/r"
                  openFile={() => {}}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </Shell>
  )
}

const MERGED = note('msg_3', 'system:steward', 'Merge lock released\nmain is free again.')
const REVIEW = note(
  'msg_4',
  'system:steward',
  'Review requested on POD-2242\nThe fold change is ready.',
)
const REBASED = note('msg_5', 'issue:POD-2242', 'Rebased and ready to land\nTip is 98aad23.')

function Harness(): JSX.Element {
  return (
    <ThemeProvider>
      <div className="bg-background p-6" data-testid="feed">
        <div className="mx-auto max-w-[720px]">
          <Prose text="On it. I'll rebase, run the checks and take the merge lock." />
          <Tools phrase="Ran podium issue show POD-2242" />
          <Notes envelopes={[MERGED]} ts="2026-10-28T17:15:00Z" />
          <Notes envelopes={[REVIEW]} ts="2026-10-28T17:15:00Z" />
          <Tools phrase="Ran git rebase main" />
          <Notes envelopes={[REBASED]} ts="2026-10-28T17:16:00Z" />
          <OpenTools
            phrase="Ran pnpm check, podium merge-lock acquire main +1"
            blocks={[
              bash('b1', 'pnpm check', '2026-10-28T17:16:10Z', 'All checks passed in 2m 08s'),
              bash('b2', 'podium merge-lock acquire main', '2026-10-28T17:18:20Z', 'acquired'),
              bash('b3', 'podium issue action --kind merge', '2026-10-28T17:18:31Z', 'Landed'),
            ]}
          />
          <Prose text="POD-2242 is on main. Two notes came in meanwhile." />
          <Notes envelopes={[READY, ASK]} ts="2026-10-28T22:17:00Z" open />
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
