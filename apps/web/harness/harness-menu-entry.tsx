import { createRoot } from 'react-dom/client'
import { NewPanelMenu } from '@/app/NewPanelMenu'
import { worktree } from './harness-menu-fixture'
import '@/index.css'
import '@/styles.css'

document.documentElement.setAttribute('data-theme', 'podium')
if (new URLSearchParams(location.search).get('theme') === 'dark')
  document.documentElement.classList.add('dark')

const root = document.getElementById('root')
if (!root) throw new Error('Missing harness root')
createRoot(root).render(
  <main className="min-h-screen bg-background p-4 text-foreground sm:p-12">
    <div className="mx-auto max-w-3xl overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex h-10 items-center gap-4 border-b border-border px-4 text-xs text-text-dim">
        <span>Fix flaky upload test</span>
        <span>Shell</span>
        <NewPanelMenu worktree={worktree} onOpened={() => {}} open />
      </div>
      <div className="h-96 bg-muted/20" />
    </div>
  </main>,
)
