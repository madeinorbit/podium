import type { HostMetricsWire } from '@podium/protocol'
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
      <Row label="Maximum idle sessions">
        <div className="flex min-w-0 flex-col items-end gap-1">
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
                    e.target.value === '' ? null : clampInt(e.target.value, 0, 10000, 30),
                },
              })
            }
          />
          <p className="max-w-md text-right text-xs text-muted-foreground">
            Per machine. Empty means unlimited. This is a convergence target for eligible idle live
            sessions, not a hard cap; protected or ineligible sessions stay live. Count and memory
            pressure act independently.
          </p>
          {unmet > 0 && (
            <p className="text-right text-xs font-medium text-amber-600 dark:text-amber-400">
              Cap unmet: {unmet} protected/ineligible
            </p>
          )}
        </div>
      </Row>
    </Section>
  )
}
