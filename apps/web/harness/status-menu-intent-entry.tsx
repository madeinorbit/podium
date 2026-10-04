/** Real status picker and stylesheet inside its native row-button boundary.
 * Synthetic, with no store/RPC: probe records menu picks and row activation. */
import { createRoot } from 'react-dom/client'
import { ThemeProvider } from '@/app/theme'
import { IssueStatusPicker } from '@/features/issues/IssueStatusPicker'
import { makeIssue } from '@/lib/test-issue'
import '@/index.css'
import '@/styles.css'

const probe = { picks: [] as string[], opens: [] as string[] }
Object.assign(window, { probe })
const issues = [
  makeIssue({ id: 'intent-review', title: 'Review the next task', stage: 'in_progress' }),
  makeIssue({ id: 'intent-fold', title: 'Keep the list position', stage: 'backlog' }),
  makeIssue({ id: 'intent-label', title: 'Choose a clear label', stage: 'review' }),
]

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <ThemeProvider>
      <div className="flex h-screen flex-col bg-background text-foreground">
        <div className="flex h-(--section-bar-h) flex-none items-center border-hairline-bar border-b bg-bar px-4 font-mono text-[11px] text-text-dim">
          Status picker
        </div>
        <div data-testid="intent-rows">
          {issues.map((issue) => (
            <button
              key={issue.id}
              type="button"
              data-pressable
              data-testid="intent-row"
              className="issue-scope flex w-full items-center gap-2.5 border-hairline-soft border-b px-4 py-2 text-left"
              onClick={() => probe.opens.push(issue.id)}
            >
              <IssueStatusPicker issue={issue} onPick={(value) => probe.picks.push(value)} />
              <span>{issue.title}</span>
            </button>
          ))}
        </div>
      </div>
    </ThemeProvider>,
  )
}
