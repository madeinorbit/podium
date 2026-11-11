import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AppSheet } from '@/app/AppSheet'
import { Button } from '@/components/ui/button'
import type { UpdatePanelView } from '@/features/updates/operation-view'
import { UpdatePanel } from '@/features/updates/UpdatePanel'
import '@/index.css'
import '@/styles.css'

const offer: UpdatePanelView = {
  state: 'offer',
  title: 'Podium 1.0.0',
  channel: 'stable',
  dismiss: { label: 'Later' },
  steps: [],
  awaitingElsewhere: [],
  indicator: 'attention',
  indicatorLabel: 'Update available',
}

function Fixture() {
  const [sheet, setSheet] = useState<string | null>(null)
  const [offered, setOffered] = useState(true)
  const [enabled, setEnabled] = useState(false)
  return (
    <>
      {['Settings', 'Usage'].map((label) => (
        <Button key={label} onClick={() => setSheet(label)}>
          Open {label}
        </Button>
      ))}
      {sheet && (
        <AppSheet label={sheet} title={sheet} onClose={() => setSheet(null)}>
          {/* Deliberately occupy the update card's corner to exercise hit testing. */}
          <Button
            style={{ position: 'absolute', right: 32, bottom: 32 }}
            aria-pressed={enabled}
            onClick={() => setEnabled(!enabled)}
          >
            Sheet control
          </Button>
        </AppSheet>
      )}
      {/* Mount after the sheet too: DOM order must not let an offer win. */}
      {offered && (
        <UpdatePanel
          view={offer}
          pending={null}
          onAction={() => {}}
          onHide={() => setOffered(false)}
        />
      )}
    </>
  )
}

createRoot(document.getElementById('root')!).render(<Fixture />)
