import type { PodiumSettings } from '@podium/runtime'
import { observer } from 'mobx-react-lite'
import type { JSX } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { backstopHours, backstopMinutes } from './hibernation-values'
import { CommitInput, clampInt, NumberRow, Row, Section, Subsection } from './shared'

/** Idle-session limits apply across the workspace. Worktree cleanup moves with Projects. */
export const HibernationSection = observer(function HibernationSection({
  settings,
  patch,
  idleCapUnmet = 0,
}: {
  settings: PodiumSettings
  patch: (p: Partial<PodiumSettings>) => void
  idleCapUnmet?: number
}): JSX.Element {
  const hibernation = settings.hibernation
  return (
    <Section
      title="Idle sessions"
      hint="A paused session frees its memory and resumes in one click, right where it was. Applies to every machine."
    >
      <Row
        setting="hibernation.enabled"
        label="Pause idle sessions"
        description="Pause quiet sessions automatically to free memory."
      >
        <Switch
          aria-label="Pause idle sessions"
          checked={hibernation.enabled}
          onCheckedChange={(enabled) => patch({ hibernation: { ...hibernation, enabled } })}
        />
      </Row>
      <fieldset
        disabled={!hibernation.enabled}
        aria-disabled={!hibernation.enabled}
        aria-label="Idle-session limits"
        className="m-0 min-w-0 border-0 border-t border-hairline-soft/60 p-0 disabled:opacity-50"
      >
        <NumberRow
          setting="hibernation.idleMinutes"
          label="A session is idle after"
          description="How long an agent must be quiet before it may be paused."
          min={1}
          max={1440}
          unit="min"
          value={hibernation.idleMinutes}
          onChange={(value) =>
            patch({ hibernation: { ...hibernation, idleMinutes: Math.round(value ?? 30) } })
          }
        />
        <NumberRow
          setting="hibernation.maxIdleSessions"
          label="Keep at most"
          description={
            <>
              Idle sessions per machine before the oldest are paused. Sessions you are watching are
              never paused.
              {idleCapUnmet > 0 && (
                <span className="mt-1 block font-medium text-warning">
                  Cap unmet: {idleCapUnmet} protected/ineligible
                </span>
              )}
            </>
          }
          min={0}
          max={10000}
          unit="idle"
          placeholder="No limit"
          value={hibernation.maxIdleSessions}
          onChange={(value) =>
            patch({
              hibernation: {
                ...hibernation,
                maxIdleSessions: value == null ? null : Math.round(value),
              },
            })
          }
        />
        <NumberRow
          setting="hibernation.memoryPct"
          label="Pause sooner when memory is above"
          description="Pause eligible idle sessions when this much of the machine’s memory is in use."
          min={50}
          max={95}
          unit="%"
          value={hibernation.memoryPct}
          onChange={(value) =>
            patch({ hibernation: { ...hibernation, memoryPct: Math.round(value ?? 80) } })
          }
        />
        <NumberRow
          setting="hibernation.loadPerCore"
          label="Pause sooner when load is above"
          description="Per CPU core. The LOAD meter in the top bar fills against this. Empty turns it off."
          min={0.5}
          max={8}
          step={0.1}
          unit="per core"
          placeholder="Off"
          value={hibernation.loadPerCore}
          onChange={(value) =>
            patch({ hibernation: { ...hibernation, loadPerCore: value ?? null } })
          }
        />
        <NumberRow
          setting="hibernation.idleShellMinutes"
          label="Close idle shells after"
          description="Plain shells with no input or output. Empty keeps them open."
          min={1}
          max={43200}
          unit="min"
          placeholder="Never"
          value={hibernation.idleShellMinutes}
          onChange={(value) =>
            patch({
              hibernation: {
                ...hibernation,
                idleShellMinutes: value == null ? null : Math.round(value),
              },
            })
          }
        />
        <NumberRow
          setting="hibernation.backstopMinutes"
          label="Always pause after"
          description="A last resort for sessions quiet this long, unless a wake-up is scheduled."
          min={1}
          max={720}
          unit="hours"
          placeholder="Never"
          value={backstopHours(hibernation.backstopMinutes)}
          onChange={(value) =>
            patch({ hibernation: { ...hibernation, backstopMinutes: backstopMinutes(value) } })
          }
        />
      </fieldset>

      <Subsection
        title="Worktree GC"
        hint="Closed issues keep their checkouts until age and policy say otherwise. Propose records what it would free; auto applies. Uncommitted changes always refuse."
      >
        <Row
          setting="worktreeGc.mode"
          label="Mode"
          description="Propose is the default so a first run of a large backlog is inspectable before anything is deleted from disk."
        >
          <Select
            value={settings.worktreeGc.mode}
            onValueChange={(value) =>
              patch({
                worktreeGc: {
                  ...settings.worktreeGc,
                  mode: value as 'off' | 'propose' | 'auto',
                },
              })
            }
          >
            <SelectTrigger aria-label="Worktree GC mode" className="w-[140px] flex-none">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="off">Off</SelectItem>
              <SelectItem value="propose">Propose</SelectItem>
              <SelectItem value="auto">Auto</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <Row
          setting="worktreeGc.afterDays"
          label="After (days)"
          description="Measured from the issue's closedAt. Archive already frees on its way past; this sweeps the closed-but-never-archived tail."
        >
          <CommitInput
            aria-label="Worktree GC after days"
            className="w-[90px] flex-none"
            type="number"
            min={1}
            max={730}
            value={settings.worktreeGc.afterDays}
            onChange={(e) =>
              patch({
                worktreeGc: {
                  ...settings.worktreeGc,
                  afterDays: clampInt(e.target.value, 1, 730, 14),
                },
              })
            }
          />
        </Row>
      </Subsection>
    </Section>
  )
})
