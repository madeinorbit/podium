/**
 * FIRST FLIGHTS MOMENT 1 IN A BROWSER (POD-2196).
 *
 * The shipping composer needs the whole store pool, so this page lays out the
 * box with the composer's own `cold-start-*` styles and wires the REAL cards,
 * ghost and tip host the way ColdStartComposer does. `bunx vite --config
 * vite.tips.config.ts` in apps/web, then open `/harness/first-prompt-tip.html`
 * (`?theme=dark`, `?draft=…` for text already in the box).
 */
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  FIRST_PROMPT_ANCHOR,
  FirstPromptGhost,
  firstPromptCards,
} from '@/features/setup/FirstPromptTip'
import { TipHost, useTipMoment } from '@/features/tips'
import { MemoryTipLog } from '@/features/tips/memory-tip-log'
import '@/index.css'
import '@/styles.css'

const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = 'podium'
document.documentElement.classList.toggle('dark', params.get('theme') === 'dark')
document.body.style.background = 'var(--background)'

function Composer() {
  const input = useRef<HTMLTextAreaElement>(null)
  const [ghost, setGhost] = useState(false)
  const [showing, setShowing] = useState(false)
  useTipMoment('first-prompt', {
    active: true,
    cards: firstPromptCards({
      setGhost,
      setShowing,
      focusComposer: () => input.current?.focus(),
    }),
  })
  return (
    <div className="cold-start relative flex min-h-0 flex-1 flex-col font-sans">
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="cold-start-body">
          <h2 className="cold-start-head">
            First task in <span className="cold-start-project">podium</span>
          </h2>
          <fieldset
            data-tip-anchor={FIRST_PROMPT_ANCHOR}
            className="cold-start-field relative min-w-0 overflow-hidden border-0 p-0"
          >
            <textarea
              ref={input}
              aria-label="What do you want to work on?"
              rows={2}
              defaultValue={params.get('draft') ?? ''}
              data-ghosted={ghost ? 'true' : undefined}
              aria-hidden={ghost || undefined}
              placeholder="What should change, and why?"
              className="cold-start-input block w-full resize-none bg-transparent text-text-strong outline-none placeholder:text-text-faint"
            />
            {ghost && <FirstPromptGhost />}
            <div className="cold-start-foot">
              <span className="px-2 text-[12px] text-muted-foreground">
                Codex <span className="text-text-faint">GPT-6.1-Sol · Max</span>
              </span>
              <span className="px-2 text-[12px] text-muted-foreground">Studio Mac</span>
              <div className="ml-auto">
                <button type="button" className="cold-start-launch" data-quiet="true">
                  Start task
                </button>
              </div>
            </div>
          </fieldset>
          <p className="cold-start-tip" style={showing ? { visibility: 'hidden' } : undefined}>
            Something big? <button type="button">Try adding a coordinator prompt</button>
          </p>
        </div>
      </div>
    </div>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('Missing harness root')
root.style.height = '100vh'
root.style.display = 'flex'
createRoot(root).render(
  <TipHost log={new MemoryTipLog()} gapMs={0}>
    <Composer />
  </TipHost>,
)
