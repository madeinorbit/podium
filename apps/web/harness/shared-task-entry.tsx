/**
 * BOB OPENS ALICE'S TASK, IN A BROWSER (POD-6295; design §2.2, §2.3).
 *
 * The task page's shared pieces with a stubbed three-member roster (the reader
 * is Bob) and stubbed server answers: the Assignee row with its reassign menu,
 * Alice's sessions as D13 summaries, the Origin block with names, the
 * collaborators and `Visible to all members`, the description with its history
 * and a revision conflict, and a comment thread where only Bob's own comment
 * can be edited. `window.probe` records reassignments, restores and edits.
 *
 *   cd apps/web && bunx vite --config vite.shared-task-harness.config.ts --port <port>
 *   bun harness/shared-task-shots.ts <port> <outDir>
 */
import type { ActivityItem } from '@podium/client-core/values'
import type { JSX } from 'react'
import { createRoot } from 'react-dom/client'
import type { IssueViewModel } from '@/app/store'
import { ThemeProvider } from '@/app/theme'
import { SectionHeading } from '@/features/issues/issue-page/chrome'
import { IssueAbout } from '@/features/issues/issue-page/IssueAbout'
import { IssueActivitySection } from '@/features/issues/issue-page/IssueActivity'
import { IssueAssignee } from '@/features/issues/issue-page/IssueAssignee'
import { IssueDescription } from '@/features/issues/issue-page/IssueBody'
import { OtherMemberSessionRow } from '@/features/issues/issue-page/IssueSessionsBlock'
import { IssueTextHistory } from '@/features/issues/issue-page/IssueTextHistory'
import type { IssuePageCommands } from '@/features/issues/issue-page-commands'
import { TextConflict } from '@/features/issues/issue-text-save'
import { makeIssue } from '@/lib/test-issue'
import { harnessRoster } from './shared-task-roster'
import '@/index.css'
import '@/styles.css'

declare global {
  interface Window {
    probe: { reassigned: string[]; restored: number[]; edited: string[] }
  }
}
const probe: Window['probe'] = { reassigned: [], restored: [], edited: [] }
window.probe = probe

const roster = harnessRoster
const nameOf = (id: string) => roster.nameOf(id)

const ISSUE = makeIssue({
  id: 'i-6295',
  seq: 6295,
  title: 'Invite flow copy',
  description: 'Invite copy, second pass: shorter subject line, one call to action.',
  assignee: 'mem_alice',
  owner: 'mem_alice',
  legacyAssignee: 'agent:codex',
  createdBy: { actor: { kind: 'agent', id: 'agent-9' }, onBehalfOf: 'mem_alice' },
  visibility: 'personal',
} as Parameters<typeof makeIssue>[0]) as unknown as IssueViewModel

const SUMMARIES = [
  { owner: 'mem_alice', title: 'Invite flow copy', state: 'live' as const },
  { owner: 'mem_alice', title: 'Copy review notes', state: 'idle' as const },
]

const REVISIONS = [
  {
    id: 11,
    field: 'description' as const,
    body: 'First draft of the invite copy.',
    source: 'create' as const,
    restoredFrom: null,
    issueRevision: 1,
    actor: 'agent-9',
    onBehalfOf: 'mem_alice',
    createdAt: '2026-11-03T10:00:00.000Z',
  },
  {
    id: 12,
    field: 'description' as const,
    body: ISSUE.description,
    source: 'edit' as const,
    restoredFrom: null,
    issueRevision: 4,
    actor: 'mem_carol',
    onBehalfOf: 'mem_carol',
    createdAt: '2026-11-04T08:00:00.000Z',
  },
]

const today = new Date().toISOString().slice(0, 10)
const FEED: ActivityItem[] = [
  {
    kind: 'event',
    id: 'e|1',
    ts: `${today}T08:30:00.000Z`,
    line: {
      icon: 'generic',
      text: 'reassigned',
      members: { by: 'mem_carol', from: 'mem_carol', to: 'mem_alice' },
    },
  },
  {
    kind: 'comment',
    id: 'c|alice',
    ts: `${today}T09:00:00.000Z`,
    author: 'Alice Martin',
    body: 'I started on the copy; my agent is drafting variants.',
    commentId: 'c-alice',
    authorId: 'mem_alice',
    mayEdit: false,
  },
  {
    kind: 'event',
    id: 'e|2',
    ts: `${today}T09:02:00.000Z`,
    line: { icon: 'generic', text: 'edited the description', members: { by: 'mem_carol' } },
  },
  {
    kind: 'comment',
    id: 'c|bob',
    ts: `${today}T09:05:00.000Z`,
    author: 'Bob Keller',
    body: 'I will review the variants this afternoon.',
    commentId: 'c-bob',
    authorId: 'mem_bob',
    editedAt: `${today}T09:06:00.000Z`,
    editedBy: 'mem_bob',
    mayEdit: true,
  },
]

const commands = { refreshAssistant: () => {} } as unknown as IssuePageCommands
const conflict = new TextConflict(
  'description',
  6,
  'Carol rewrote the invite copy: two calls to action, longer subject line.',
)

function Harness(): JSX.Element {
  return (
    <ThemeProvider>
      <div className="flex min-h-screen bg-background text-foreground">
        <main className="flex min-w-0 flex-1 flex-col gap-2 px-10 pt-8">
          <h1 className="mb-2 font-semibold text-[22px]">{ISSUE.title}</h1>
          <div data-testid="harness-description">
            <IssueDescription
              issue={ISSUE}
              busy={false}
              editing={false}
              onEditingChange={() => {}}
              onCommit={() => {}}
            >
              <IssueTextHistory
                issueId={ISSUE.id}
                field="description"
                current={ISSUE.description}
                mayRestore
                busy={false}
                load={async () => REVISIONS}
                onRestore={(id, done) => {
                  probe.restored.push(id)
                  done()
                }}
              />
            </IssueDescription>
          </div>
          <div data-testid="harness-conflict">
            <IssueDescription
              issue={ISSUE}
              busy={false}
              editing
              onEditingChange={() => {}}
              onCommit={() => {}}
              conflict={conflict}
              draft="Bob’s version: one call to action, shorter subject line."
            />
          </div>
          <IssueActivitySection
            issue={ISSUE}
            busy={false}
            commands={commands}
            feed={FEED}
            onEditComment={(_id, body) => probe.edited.push(body)}
          />
        </main>
        <aside className="flex w-[296px] shrink-0 flex-col border-border/70 border-l bg-rail/55">
          <div className="flex flex-col px-5 py-4">
            <IssueAssignee
              issue={ISSUE}
              roster={roster}
              mayReassign
              busy={false}
              onReassign={(id) => probe.reassigned.push(id)}
            />
          </div>
          <div className="flex flex-col gap-2 px-5 py-4">
            <SectionHeading count="2">Sessions</SectionHeading>
            <div className="flex flex-col" data-testid="other-member-sessions">
              {SUMMARIES.map((summary) => (
                <OtherMemberSessionRow
                  key={summary.title}
                  summary={summary}
                  owner={nameOf(summary.owner) ?? 'a member'}
                />
              ))}
            </div>
          </div>
          <div className="flex flex-col px-5 py-4">
            <IssueAbout
              issue={ISSUE}
              about={{ nameOf, collaborators: ['mem_alice', 'mem_carol'] }}
            />
          </div>
        </aside>
      </div>
    </ThemeProvider>
  )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<Harness />)
