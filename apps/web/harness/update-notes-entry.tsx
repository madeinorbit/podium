/**
 * The update panel offering a release, with the 0.3.0 changelog section as its notes. Query:
 * `theme=light`, `link=1` (a stable release's page link), `short=1` (notes that fit).
 */
import { createRoot } from 'react-dom/client'
import type { UpdatePanelView } from '@/features/updates/operation-view'
import { UpdatePanel } from '@/features/updates/UpdatePanel'
import '@/index.css'
import '@/styles.css'

const query = new URLSearchParams(window.location.search)
document.documentElement.setAttribute('data-theme', 'podium')
if (query.get('theme') !== 'light') document.documentElement.classList.add('dark')

const NOTES = `**One flight deck for the whole mission, a calmer chat, and a server that uses far less memory.**

### What's new

- **Flight deck.** A task's deck now shows the whole mission in one view: its phases, every task and its state, who is working on what, what is blocked and by what, and the proposals that wait for you. Done work stays visible. Toggle it with ⌘B. The right sidebar moves to ⌥⌘B.
- **Agent profiles.** An agent profile names the agent, model and effort for a kind of work. Pick one for a task, and its subtasks use it too. Podium comes with six starter profiles.
- **Model and effort in the composer.** The chat composer shows the session's model and effort. New tasks remember the agent and model you last used, and Settings warns when a model you chose is not available on your machines.
- **A calmer chat.** Tool runs and notes fold into quiet one-line rows, with the time in the margin. Mail between agents shows as "Note to …" cards, and compaction summaries show as quiet notes.
- **Quote into chat.** Select text in a reply or a review finding and add it to your next message as a quote.
- **Attachments that stay.** Files and images you attach are stored on the server and saved with the task. They work with every agent and survive a reload.
- **A calmer workspace.** The sidebar lists only your tasks, grouped by repository, on web and phone. Markdown opens in a full-height reading view with an outline and reading progress.
- **Repositories.** Settings → Repos lists each repository once, by one name. You can set the branch that new tasks start from and land on. A landed task shows as landed.
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

const view: UpdatePanelView = {
  state: 'offer',
  title: 'Podium 0.3.0 is available',
  subtitle: 'Your server and 2 machines will update',
  version: '0.3.0',
  places: [
    { kind: 'server', label: 'Server', effect: 'Restarts for a few seconds', impact: 'interrupts' },
    {
      kind: 'machine',
      label: 'flatblock',
      effect: 'Updates in the background',
      impact: 'background',
    },
  ],
  steps: [],
  awaitingElsewhere: [],
  primary: { kind: 'apply', label: 'Update now', pendingLabel: 'Starting…' },
  notes: {
    summary: query.get('short') ? SHORT : NOTES,
    ...(query.get('link')
      ? { url: 'https://github.com/madeinorbit/podium/releases/tag/v0.3.0' }
      : {}),
  },
  indicator: 'dot',
  indicatorLabel: 'Update available',
} as unknown as UpdatePanelView

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <div className="h-screen bg-background">
      <UpdatePanel view={view} pending={null} onAction={() => {}} onHide={() => {}} />
    </div>,
  )
}
