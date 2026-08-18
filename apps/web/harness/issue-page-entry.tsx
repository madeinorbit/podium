/**
 * A REFUSED WRITE, PHOTOGRAPHED WHERE THE OPERATOR SEES IT (POD-1266).
 *
 * The report was about placement, not about wiring: `Start work` failed, and the
 * failure appeared as small grey text pinned under the whole page, below the
 * activity feed and below the comment composer. A unit test can prove which
 * component the message reaches; only a browser can show that it now arrives
 * over the page instead of under it, because sonner's toast is positioned, sized
 * and themed entirely by CSS (`.cn-toast` in styles.css) that jsdom never
 * applies.
 *
 * So this mounts the shipping `IssuePage` against the real stylesheet, inside
 * the shell's top-bar spacing — the `<Toaster/>` offset is
 * `topbar-h + 10px`, so a harness without that reserve photographs the toast
 * against the wrong ceiling. `harness/issue-page-store.ts` stands in for the
 * store, and its `issues.start` rejects with the filed git error.
 *
 * `window.probe.start()` presses the button; `window.probe.legacy()` draws the
 * strip the page used to render, for the before shot.
 */
import type { IssueId } from '@podium/model/browser'
import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider } from '@/app/theme'
import { Toaster } from '@/components/ui/sonner'
import { IssuePage } from '@/features/issues/IssuePage'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import { makeIssue } from '@/lib/test-issue'
import '@/index.css'
import '@/styles.css'
import { START_FAILURE, state } from './issue-page-store'

declare global {
  interface Window {
    probe: {
      /** Press `Start work` — the stubbed mutation rejects. */
      start: () => void
      /** Draw the pre-fix strip, for the before shot. */
      legacy: (on: boolean) => void
    }
  }
}

/** The filed case: a backlog task with no worktree yet, so the launch box offers
 *  `Start work` rather than `+ Session`. */
const ISSUE = makeIssue({
  id: 'i-1262',
  seq: 1262,
  title: 'Main red on typecheck blocks redeploy',
  description:
    "The repository's main branch currently fails its typecheck, which stops any merged work from reaching the running server on this host. One mobile test file is the cause. Until it is fixed, changes land in main but the app keeps serving the older code.",
  stage: 'backlog',
  worktreePath: null,
  branch: null,
  defaultAgent: 'claude-code',
})

state.issues = [ISSUE]

function Harness(): JSX.Element {
  const [legacy, setLegacy] = useState(false)

  useEffect(() => {
    window.probe = {
      start: () => {
        const button = Array.from(document.querySelectorAll('button')).find(
          (b) => b.textContent?.trim() === 'Start work',
        )
        button?.click()
      },
      legacy: (on) => setLegacy(on),
    }
  }, [])

  return (
    <ThemeProvider>
      <div className="desktop-shell">
        {/* The bar the toast clears. Without it the toast photographs against a
            ceiling production never gives it. */}
        <div
          className="flex-none border-hairline-bar border-b bg-bar"
          style={{ height: 'var(--topbar-h)' }}
        />
        <div className="desktop-shell-row">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <ConfirmProvider>
              <IssuePage
                issue={ISSUE}
                orderedIds={[ISSUE.id as IssueId]}
                onBack={() => {}}
                onNavigate={() => {}}
              />
            </ConfirmProvider>
            {/* THE BEFORE SHOT. Byte-for-byte the block IssuePage rendered
                before this change (git show HEAD~:…/IssuePage.tsx), so the two
                photographs differ only in the thing under review. */}
            {legacy && (
              <div
                className="border-border border-t px-4 py-2 whitespace-pre-wrap break-words text-[12px] text-muted-foreground"
                role="status"
              >
                {START_FAILURE}
              </div>
            )}
          </div>
        </div>
      </div>
      <Toaster
        position="top-center"
        offset={{ top: 'calc(env(safe-area-inset-top, 0px) + var(--topbar-h) + 10px)' }}
        mobileOffset={{ top: 'calc(env(safe-area-inset-top, 0px) + var(--topbar-h) + 8px)' }}
      />
    </ThemeProvider>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(<Harness />)
