import type { HostMetricsWire } from '@podium/model'
import type { PodiumSettings } from '@podium/runtime'
import type { JSX } from 'react'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { clampInt, Row, Section } from './shared'

/** Auto-hibernation thresholds for idle sessions on memory pressure. */
export function HibernationSection({
  settings,
  patch,
  hostMetrics = [],
}: {
  settings: PodiumSettings
  patch: (p: Partial<PodiumSettings>) => void
  hostMetrics?: HostMetricsWire[]
}): JSX.Element {
  const unmet = hostMetrics.reduce((sum, host) => sum + (host.idleCapUnmet ?? 0), 0)
  return (
    <Section
      title="Auto-hibernation"
      hint="Idle sessions hibernate to relieve memory pressure or converge toward the per-machine idle-session target. One click resumes them."
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
      {/* The explanation belongs under the label like every other row's — it was
          left-aligned prose inside the right-hand CONTROL cell, which is the one
          place on this screen that is not a text column. */}
      <Row
        label="Maximum idle sessions"
        description={
          <>
            Per machine. Empty means unlimited. This is a convergence target for eligible idle live
            sessions, not a hard cap; protected or ineligible sessions stay live. Count and memory
            pressure act independently.
            {unmet > 0 && (
              <span className="mt-1 block font-medium text-warning">
                Cap unmet: {unmet} protected/ineligible
              </span>
            )}
          </>
        }
      >
        <Input
          aria-label="Maximum idle sessions"
          className="w-[90px] flex-none"
          type="number"
          min={0}
          placeholder="Unlimited"
          value={settings.hibernation.maxIdleSessions ?? ''}
          onChange={(e) =>
            patch({
              hibernation: {
                ...settings.hibernation,
                maxIdleSessions:
                  e.target.value === '' ? null : clampInt(e.target.value, 0, 10000, 8),
              },
            })
          }
        />
      </Row>
    </Section>
  )
}
