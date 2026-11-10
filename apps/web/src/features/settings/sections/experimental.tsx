import { observer } from 'mobx-react-lite'
import { settingsRowId } from '../page-definitions'
/**
 * Settings → Experimental [spec:SP-f4b9]: listed feature flags with user
 * toggles. Enablement edits patch the settings blob and ride Save.
 */

import type { PodiumSettings } from '@podium/runtime'
import type { JSX } from 'react'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { type FeatureStates, useFeaturesState } from '@/lib/use-feature'
import { Section, Subsection } from './shared'

type FeatureFlagWire = FeatureStates['flags'][number]

/** Listed only because of dev mode (invisible on this channel in release builds). */
function isDevOnlyListed(flag: FeatureFlagWire, channel: 'stable' | 'edge'): boolean {
  if (flag.visibility === 'stable') return false
  if (flag.visibility === 'edge' && channel === 'edge') return false
  return true
}

export const ExperimentalSection = observer(function ExperimentalSection({
  settings,
  patch,
  onReset,
}: {
  settings: PodiumSettings
  patch: (p: Partial<PodiumSettings>) => void
  /** Replaces the whole local blob with DEFAULT_SETTINGS; the change still rides
   *  the dirty-bar Save, so it is reviewable and discardable (POD-127 F4). */
  onReset: () => void
}): JSX.Element {
  const [confirmingReset, setConfirmingReset] = useState(false)
  // The instance settings record's flags (same as useFeature): the server's
  // facts joined with the SAVED toggles [spec:SP-f4b9]. A switch below edits
  // the draft; the flag moves once Save writes the record.
  const state = useFeaturesState()
  const listed = state?.flags.filter((f) => f.listed) ?? []
  const channel = state?.channel ?? 'stable'
  const channelLabel = channel === 'edge' ? 'edge' : 'stable'

  return (
    <Section
      title="Experimental"
      hint={`Pre-release features for this install (update channel: ${channelLabel}). Changes apply after Save unless noted below.`}
    >
      {!state && <p className="settings-prose">Loading experimental features…</p>}
      {state && listed.length === 0 && (
        <p className="settings-prose">No experimental features are available on this install.</p>
      )}
      {/* A flag row is a Row: same two columns, same seam, same measure — it just
          carries a badge. It had its own flex layout and its own sizes. */}
      {listed.map((flag) => {
        const checked = flag.locked ? flag.enabled : (settings.experimental?.[flag.id] ?? false)
        const showDevBadge = Boolean(state?.devMode && isDevOnlyListed(flag, channel))
        return (
          <div
            key={flag.id}
            id={settingsRowId('experimental', flag.name)}
            className="settings-row"
            tabIndex={-1}
          >
            <div className="min-w-0">
              <span className="settings-label inline-flex flex-wrap items-center gap-1.5">
                {flag.name}
                {showDevBadge && (
                  <Badge variant="outline" className="h-4 px-1.5 text-[11px]">
                    Dev
                  </Badge>
                )}
              </span>
              <p className="settings-prose mt-1">{flag.description}</p>
              {flag.locked && <p className="settings-micro mt-1">Set by config file</p>}
            </div>
            <div className="settings-control">
              <Switch
                className="flex-none"
                checked={checked}
                disabled={flag.locked}
                onCheckedChange={(next) =>
                  patch({
                    experimental: { ...settings.experimental, [flag.id]: next },
                  })
                }
              />
            </div>
          </div>
        )
      })}
      <Subsection
        title="Reset settings"
        hint="Replaces every setting on this page and all others with Podium's defaults. Nothing is saved until you confirm the change in the save bar."
      >
        {confirmingReset ? (
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => {
                onReset()
                setConfirmingReset(false)
              }}
            >
              Reset everything to defaults
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setConfirmingReset(false)}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setConfirmingReset(true)}
          >
            Reset to defaults…
          </Button>
        )}
      </Subsection>
    </Section>
  )
})
