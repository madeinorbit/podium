/** Review gallery: theme=light, set=core|recovery, state=<id>, short=1. */
import { parseOperation, type ReleaseProposal } from '@podium/protocol'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { operationView, type UpdatePanelView } from '@/features/updates/operation-view'
import { ReleaseProposalCard } from '@/features/updates/ReleaseProposalCard'
import { UpdatePanel } from '@/features/updates/UpdatePanel'
import type { UpdateView } from '@/features/updates/update-view'
import '@/index.css'
import '@/styles.css'

const query = new URLSearchParams(window.location.search)
document.documentElement.setAttribute('data-theme', 'podium')
document.documentElement.classList.toggle('dark', query.get('theme') !== 'light')
const NOTES = `**One flight deck for the whole mission, a calmer chat, and a server that uses far less memory.**

### What's new

- **Flight deck.** A task's deck now shows the whole mission in one view: its phases, every task and its state, who is working on what, what is blocked and by what, and the proposals that wait for you. Done work stays visible. Toggle it with ⌘B. The right sidebar moves to ⌥⌘B.
- **Agent profiles.** An agent profile names the agent, model and effort for a kind of work. Pick one for a task, and its subtasks use it too. Podium comes with six starter profiles.
- **Model and effort in the composer.** The chat composer shows the session's model and effort. New tasks remember the agent and model you last used, and Settings warns when a model you chose is not available on your machines.
- **A calmer chat.** Tool runs and notes fold into quiet one-line rows, with the time in the margin. Mail between agents shows as "Note to …" cards, and compaction summaries show as quiet notes.
- **Quote into chat.** Select text in a reply or a review finding and add it to your next message as a quote.
- **Attachments that stay.** Files and images you attach are stored on the server and saved with the task. They work with every agent and survive a reload.
- **A calmer workspace.** The sidebar lists only your tasks, grouped by repository, on web and phone. Markdown opens in a full-height reading view with an outline and reading progress.
- **Repositories.** Settings → Projects lists each repository once, by one name. You can set the branch that new tasks start from and land on. A landed task shows as landed.
- **Telegram.** Attach a Telegram chat to one of your sessions with \`/attach\`, and talk to that session from your phone. \`/detach\` returns the chat to the superagent.
- **First Flights.** New users get short tips the first time something appears: the first prompt, the first offer, the first artifact and the first proposal.
- **Less memory, faster start.** The server no longer keeps a copy of all your data in memory. In our benchmark of a large workspace it used about 330 MB instead of about 1.2 GB, memory stopped growing with the data, and it started 8–52% faster.
- **More reliable updates.** Large update downloads no longer fail when a machine pauses, and no update step can wait forever.
- **And more.** A designed macOS installer window, fullscreen fixes on Macs with a notch, Codex questions in the question card, and many smaller fixes.

### Removed

- Task colors.
- The chat's tl;dr line.
- The deck's view picker on desktop. The Working, Needs you and Timeline views are gone, and the deck has one view.
- Sidebar folders you could fold, draft rows, the reorder dialog, the Queues panel, and the per-worktree rows. A session without a task no longer gets a sidebar row.
- The issue fields "design" and "notes". Their text moves into the brief. The CLI now refuses \`--design\` and \`--notes\`.

### Upgrading from 0.2.0

- Podium backs up your database automatically before migrating. Rolling back means restoring \`~/.podium/podium.db.backup-vupdate-*\`.
- Every client reloads once on first connect. Nothing is lost.
- The text of each issue's "design" and "notes" fields is appended to its brief, under a heading.
- Task colors are dropped.`

const SHORT = `**A smaller fix release.**

### Fixed

- **Updates.** Large downloads no longer fail when a machine pauses.`

const commits = [
  ['4e89dd1', 'Write the 0.3.0 release notes under Unreleased'],
  ['e861f21', 'Show release notes as Markdown in the update panel, and give dev builds notes'],
  ['f2a2238', 'Draw blocker lines over the row text and fade the words they cross'],
  ['c67da8b', 'Bring back the flight deck’s fold-all button'],
  ['242a453', 'Tucking the task on screen returns to the new-prompt screen'],
  ['4990cce', 'Name the moved-conversation note “Where it left off”'],
  ['ca2e8cb', 'Drop the duplicated task title from the moved-conversation subtitle'],
  ['5d62fe7', 'Build the Repos settings rows from repository records'],
  ['aa56615', 'Say the server is unreachable instead of WebKit’s parse error'],
  ['afc4cf7', 'Give the composer’s model chip a foot row of its own'],
  ['94a059b', 'Drop the web bundle byte ceilings'],
  ['294a28e', 'Pass the Podium default branch into the Projects page'],
  ['33d5c7c', 'Load the Projects settings page on demand'],
  ['3df42bf', 'Name Repos settings rows by the server-decided repo name'],
].map(([sha, summary]) => ({ sha: sha ?? '', summary: summary ?? '' }))
const notes = {
  summary: query.get('short') ? SHORT : NOTES,
  url: 'https://github.com/madeinorbit/podium/releases/tag/v0.3.0',
}
const stable: Extract<UpdateView, { state: 'available' | 'required' }> = {
  state: 'available',
  version: '0.3.0',
  runningVersion: '0.2.0',
  releasedAt: '2026-11-04',
  machineCount: 2,
  notes,
  restartNote: 'Your sessions keep running.',
  places: [
    {
      kind: 'server',
      label: 'Server',
      detail: 'ludovico',
      effect: 'Restarts for a few seconds; open sessions reconnect',
      impact: 'interrupts',
    },
    {
      kind: 'machines',
      label: 'flatblock, ludovico',
      effect: 'Update in the background; agents keep running',
      impact: 'background',
    },
    {
      kind: 'database',
      label: 'Database',
      effect: '5 schema changes, backed up first',
      impact: 'background',
    },
  ],
}
const local = { behind: false, canReload: true, canInstallDesktop: false }
const now = Date.UTC(2026, 10, 4, 12)
const offerView = (offer: UpdateView) =>
  operationView({ operation: null, offer, local, surface: 'web', now })
const operation = {
  id: 'op_demo',
  kind: 'update',
  state: 'running',
  startedAt: now - 34_000,
  updatedAt: now - 2_000,
  details: { target: { version: '0.3.0', notes } },
  steps: [
    { id: 'prepare', title: 'Prepared the update', state: 'done' },
    {
      id: 'machines',
      title: 'Updating your machines',
      state: 'running',
      lastProgressAt: now - 2_000,
      progress: { done: 1, total: 2 },
      places: [{ id: 'm1', name: 'flatblock', state: 'downloading', percent: 62 }],
    },
    {
      id: 'server',
      title: 'Restarting your server',
      state: 'pending',
      detail: 'A few seconds; sessions reconnect on their own',
    },
  ],
  awaiting: [],
}
const opView = (patch: Record<string, unknown>, behind = false) =>
  operationView({
    operation: parseOperation({ ...operation, ...patch }),
    offer: null,
    local: { ...local, behind },
    surface: 'web',
    now,
  })
const views: { id: string; label: string; view: UpdatePanelView }[] = [
  { id: 'stable', label: 'A · Stable offer', view: offerView(stable) },
  {
    id: 'dev',
    label: 'B · Development offer',
    view: offerView({
      ...stable,
      version: '0.2.0-dev.80+4e89dd1',
      runningVersion: '0.2.0-dev.79+1111111',
      branch: 'dev/mw',
      commits,
      notes: { summary: notes.summary },
      places: stable.places.filter((p) => p.kind !== 'database'),
    }),
  },
  { id: 'running', label: 'C · Running', view: opView({}) },
  {
    id: 'done',
    label: 'D · Done',
    view: opView({
      state: 'done',
      startedAt: now - 72_000,
      finishedAt: now,
      steps: operation.steps.map((step) => ({ ...step, state: 'done' })),
    }),
  },
  {
    id: 'edge',
    label: 'Edge offer · date unknown',
    view: offerView({ ...stable, version: '0.3.0-edge.2', releasedAt: undefined }),
  },
  {
    id: 'failed',
    label: 'Failed · error and technical detail',
    view: opView({
      state: 'failed',
      steps: [
        {
          id: 'machines',
          title: 'Updating your machines',
          state: 'failed',
          detail: 'flatblock could not download the update',
        },
      ],
      error: {
        code: 'download-failed',
        message: 'The download failed.',
        detail: 'download refused: HTTP 503',
      },
    }),
  },
  {
    id: 'waiting-you',
    label: 'Waiting for you · cached interface status',
    view: opView(
      {
        state: 'waiting',
        steps: operation.steps.map((step) => ({ ...step, state: 'done' })),
        awaiting: [{ id: 'reload', surface: 'web', title: 'Reload this tab', required: true }],
      },
      true,
    ),
  },
  {
    id: 'waiting-elsewhere',
    label: 'Waiting elsewhere · no local action',
    view: opView(
      {
        state: 'waiting',
        steps: [],
        awaiting: [
          {
            id: 'desktop',
            surface: 'desktop-all-in-one',
            place: 'ludovico',
            required: true,
            detail: 'Finish this in Podium Desktop on ludovico.',
          },
        ],
      },
      true,
    ),
  },
  {
    id: 'stalled',
    label: 'Stalled · silence remains explicit',
    view: opView({
      steps: [
        {
          id: 'machines',
          title: 'Updating your machines',
          state: 'stalled',
          lastProgressAt: now - 120_000,
          detail: 'Waiting for flatblock to report progress',
        },
      ],
    }),
  },
]
const proposal: ReleaseProposal = {
  headSha: '4e89dd1',
  version: '0.2.0-dev.80+4e89dd1',
  runningVersion: '0.2.0-dev.79+1111111',
  branch: 'dev/mw',
  commits,
  addedMigrations: ['20261104000000_update'],
  state: 'pending',
}
function Gallery() {
  const [light, setLight] = useState(query.get('theme') === 'light')
  const [message, setMessage] = useState('')
  const selected = views.filter((item, index) =>
    query.get('state')
      ? item.id === query.get('state')
      : query.get('set') === 'core'
        ? index < 4
        : query.get('set') === 'recovery'
          ? index >= 4
          : true,
  )
  return (
    <main className="update-harness">
      <header className="update-harness-heading">
        <div>
          <h1>Update panel</h1>
          <p>
            Release notes, dev commits and a calmer update. Try the tabs, Details and notes
            disclosure.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            document.documentElement.classList.toggle('dark', light)
            setLight(!light)
          }}
        >
          Light / dark
        </button>
      </header>
      <div className="update-harness-grid">
        {selected.map((item) => (
          <figure className="update-harness-frame" key={item.id} data-example={item.id}>
            <UpdatePanel
              view={item.view}
              pending={null}
              onAction={(action) => setMessage(`Preview action: ${action}`)}
              onHide={() => setMessage('Preview: panel hidden in the app')}
              {...(item.id === 'waiting-you'
                ? {
                    reloadStatus: {
                      phase: 'no-replacement' as const,
                      message: 'No replacement interface was found.',
                      detail: 'The registration update check found no replacement.',
                      canReset: true,
                      snapshot: { available: true, controlled: true, active: 'activated' as const },
                    },
                    onResetCachedInterface: () => setMessage('Preview: reset cached interface'),
                  }
                : {})}
            />
            <figcaption>{item.label}</figcaption>
          </figure>
        ))}
        {query.get('set') !== 'core' &&
          !query.get('state') &&
          (['pending', 'building', 'failed'] as const).map((state) => (
            <figure className="update-harness-frame" key={state} data-example={`proposal-${state}`}>
              <ReleaseProposalCard
                proposal={{
                  ...proposal,
                  state,
                  ...(state === 'failed'
                    ? {
                        failure: {
                          message: 'Build failed. Nothing was installed.',
                          logs: 'compile exited 1\nThe published fleet is unchanged.',
                        },
                      }
                    : {}),
                }}
                pending={false}
                onApprove={() => setMessage('Preview: build and publish')}
                onHide={() => setMessage('Preview: proposal hidden')}
              />
              <figcaption>Build approval · {state}</figcaption>
            </figure>
          ))}
      </div>
      <output className="update-harness-message" aria-live="polite">
        {message}
      </output>
    </main>
  )
}
const root = document.getElementById('root')
if (root) createRoot(root).render(<Gallery />)
