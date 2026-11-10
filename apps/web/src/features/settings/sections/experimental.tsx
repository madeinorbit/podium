import { observer } from 'mobx-react-lite'
/**
 * Settings → Experimental [spec:SP-f4b9]: listed feature flags with user
 * toggles. Enablement edits save their instance preference immediately.
 */

import type { PodiumSettings } from '@podium/runtime'
import type { JSX } from 'react'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { type FeatureStates, useFeaturesState } from '@/lib/use-feature'
import { Row, Section } from './shared'

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
}: {
  settings: PodiumSettings
  patch: (p: Partial<PodiumSettings>) => void
}): JSX.Element {
  // The instance settings record's flags (same as useFeature): the server's
  // facts joined with the SAVED toggles [spec:SP-f4b9]. A switch below edits
  // the record immediately.
  const state = useFeaturesState()
  const listed = state?.flags.filter((f) => f.listed) ?? []
  const channel = state?.channel ?? 'stable'
  const channelLabel = channel === 'edge' ? 'edge' : 'stable'

  return (
    <Section
      title="Experimental"
      hint={`Pre-release features for this install (update channel: ${channelLabel}). Changes save as soon as you make them.`}
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
          <Row
            key={flag.id}
            setting="experimental"
            label={flag.name}
            description={
              <>
                {flag.description}
                {flag.locked && (
                  <span className="settings-micro mt-1 block">Set by config file</span>
                )}
                {showDevBadge && (
                  <Badge variant="outline" className="ml-2 h-4 px-1.5 text-[11px]">
                    Dev
                  </Badge>
                )}
              </>
            }
          >
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
          </Row>
        )
      })}
    </Section>
  )
})
