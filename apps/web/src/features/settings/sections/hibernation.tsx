import type { PodiumSettings } from '@podium/runtime'
import type { JSX } from 'react'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { clampInt, Row, Section } from './shared'

/** Auto-hibernation thresholds for idle sessions on memory pressure. */
export function HibernationSection({
  settings,
  patch,
}: {
  settings: PodiumSettings
  patch: (p: Partial<PodiumSettings>) => void
}): JSX.Element {
  return (
    <Section
      title="Auto-hibernation"
      hint="When a machine's memory crosses the threshold, idle sessions hibernate. One click resumes them."
    >
      <Row label="Enabled">
        <Switch
          checked={settings.hibernation.enabled}
          onCheckedChange={(checked) =>
            patch({ hibernation: { ...settings.hibernation, enabled: checked } })
          }
        />
      </Row>
      <Row label="Memory threshold (%)">
        <Input
          className="w-[90px] flex-none"
          type="number"
          min={50}
          max={95}
          value={settings.hibernation.memoryPct}
          onChange={(e) =>
            patch({
              hibernation: {
                ...settings.hibernation,
                memoryPct: clampInt(e.target.value, 50, 95, 80),
              },
            })
          }
        />
      </Row>
      <Row label="Idle after (minutes)">
        <Input
          className="w-[90px] flex-none"
          type="number"
          min={1}
          max={1440}
          value={settings.hibernation.idleMinutes}
          onChange={(e) =>
            patch({
              hibernation: {
                ...settings.hibernation,
                idleMinutes: clampInt(e.target.value, 1, 1440, 30),
              },
            })
          }
        />
      </Row>
    </Section>
  )
}
