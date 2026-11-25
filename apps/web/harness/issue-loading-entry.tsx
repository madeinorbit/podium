import { asIssueId } from '@podium/model/browser'
import { createRoot } from 'react-dom/client'
import { DockHeaderSlotProvider } from '@/app/DockHeaderSlot'
import { OperatorFocusProvider } from '@/app/operator-focus'
import type { IssueViewModel } from '@/app/store'
import { ThemeProvider } from '@/app/theme'
import { IssuePage } from '@/features/issues/IssuePage'
import { IssuePanelView } from '@/features/issues/IssuePanelView'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import '@/index.css'
import '@/styles.css'
import { device, ISSUE_ID, prepare } from './issue-loading-pool'

declare global {
  interface Window {
    issueLoading: {
      settle(): Promise<void>
      offline(): void
      requested(): readonly string[]
    }
  }
}

async function main() {
  await prepare()
  window.issueLoading = {
    settle: () => device.untilIdle(),
    offline: () => device.offline(),
    requested: () => device.requestedKeys(),
  }
  const fullPage = new URLSearchParams(location.search).has('page')
  createRoot(document.getElementById('root') as HTMLElement).render(
    <ThemeProvider>
      <ConfirmProvider>
        <OperatorFocusProvider missionId={ISSUE_ID}>
          <DockHeaderSlotProvider value={null}>
            <main className="flex h-screen justify-end bg-background">
              <aside
                className={`flex h-full max-w-full flex-col border-border border-l bg-rail ${fullPage ? 'w-full' : 'w-[380px]'}`}
                data-testid="issue-loading-harness"
              >
                <div className="border-border border-b px-[18px] py-3 text-[12px] text-muted-foreground">
                  Issue
                </div>
                {fullPage ? (
                  <IssuePage
                    issue={{ id: ISSUE_ID } as IssueViewModel}
                    orderedIds={[asIssueId(ISSUE_ID)]}
                    onBack={() => {}}
                    onNavigate={() => {}}
                  />
                ) : (
                  <IssuePanelView cwd="/synthetic" issueId={asIssueId(ISSUE_ID)} />
                )}
              </aside>
            </main>
          </DockHeaderSlotProvider>
        </OperatorFocusProvider>
      </ConfirmProvider>
    </ThemeProvider>,
  )
}

void main()
