/**
 * THE WHOLE USAGE SHEET, REAL, IN A BROWSER (POD-1861).
 *
 * The by-task section's own states live in harness/usage-tasks.html. This page
 * exists for the one claim that page cannot make: THE SHEET HAS ONE RIGHT EDGE.
 * The masthead's last reading, the provider costs, the composition ratios, the
 * new section's `Dearest` and its API-equivalent column, and the model table's
 * cost column all have to land on the same rule — a claim about five regions
 * that can only be measured with all five on screen.
 *
 * `window.usage.rightEdges()` reports them, so the check is a number rather than
 * an eyeball. The store is stubbed (see usage-sheet-store-stub.ts); everything
 * else here is the shipping sheet.
 */

import { createRoot } from 'react-dom/client'
import { TooltipProvider } from '@/components/ui/tooltip'
import { UsageView } from '@/features/usage/UsageView'
import '@/index.css'
import '@/styles.css'

declare global {
  interface Window {
    usage: { rightEdges: () => Record<string, number[]> }
  }
}

const right = (sel: string): number[] =>
  [...document.querySelectorAll(sel)].map(
    (el) => Math.round(el.getBoundingClientRect().right * 10) / 10,
  )

window.usage = {
  rightEdges: () => ({
    masthead: right('.usage-summary .usage-reading:last-child .usage-reading-value'),
    providerCost: right('.usage-provider-cost'),
    taskReading: right('.usage-task-readings .usage-reading:last-child .usage-reading-value'),
    taskCost: right('.usage-tasks .usage-td-cost'),
    compRatio: right('.usage-comp-ratio'),
    modelCost: right('.usage-table .usage-td-cost'),
  }),
}

const root = document.getElementById('root')
if (root)
  createRoot(root).render(
    <TooltipProvider delay={0}>
      <div
        style={{
          display: 'grid',
          placeItems: 'start center',
          padding: 28,
          background: 'var(--background)',
          minHeight: '100vh',
        }}
      >
        <UsageView onClose={() => {}} />
      </div>
    </TooltipProvider>,
  )
