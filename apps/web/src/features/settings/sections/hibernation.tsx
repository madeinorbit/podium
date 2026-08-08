import type { HostMetricsWire } from '@podium/model'
import type { PodiumSettings } from '@podium/runtime'
import type { JSX } from 'react'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { clampInt, clampNumber, Row, Section } from './shared'

/** Auto-hibernation thresholds for idle sessions under resource pressure. */
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
      hint="Idle sessions hibernate to relieve memory or load pressure, or to converge toward the per-machine idle-session target. One click resumes them."
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
      <Row
        label="Load per core"
        description="load1 ÷ cores. Empty turns load pressure off. Default 1.5 means the run queue is half again the core count."
      >
        <Input
          aria-label="Load per core"
          className="w-[90px] flex-none"
          type="number"
          min={0.5}
          max={8}
          step={0.1}
          placeholder="Off"
          value={settings.hibernation.loadPerCore ?? ''}
          onChange={(e) =>
            patch({
              hibernation: {
                ...settings.hibernation,
                loadPerCore:
                  e.target.value === '' ? null : clampNumber(e.target.value, 0.5, 8, 1.5),
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
            sessions, not a hard cap; protected or ineligible sessions stay live. Count, memory, and
            load pressure act independently. Quiet unobserved agents (no phase signal) count toward
            the target after at least 4 hours.
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
      <Row
        label="Idle shell hours"
        description="Park live shells after this many hours with no input or output. Empty turns shell reaping off (default). Shells are never folded into the agent idle cap."
      >
        <Input
          aria-label="Idle shell hours"
          className="w-[90px] flex-none"
          type="number"
          min={1}
          max={720}
          placeholder="Off"
          value={settings.hibernation.idleShellHours ?? ''}
          onChange={(e) =>
            patch({
              hibernation: {
                ...settings.hibernation,
                idleShellHours:
                  e.target.value === '' ? null : clampInt(e.target.value, 1, 720, 24),
              },
            })
          }
        />
      </Row>
    </Section>
  )
}
