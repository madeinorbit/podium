import { observer } from 'mobx-react-lite'
/**
 * Settings → Labs [spec:SP-f4b9]: workspace feature flags. Admins save
 * enablement edits through the instance preference record immediately.
 */

import type { PodiumSettings } from '@podium/runtime'
import type { JSX } from 'react'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { modChord } from '@/lib/mod-chord'
import { type FeatureStates, useFeaturesState } from '@/lib/use-feature'
import { Row, Section } from './shared'

type FeatureFlagWire = FeatureStates['flags'][number]

/** Listed only because of dev mode (invisible on this channel in release builds). */
function isDevOnlyListed(flag: FeatureFlagWire, channel: 'stable' | 'edge'): boolean {
  if (flag.visibility === 'stable') return false
  if (flag.visibility === 'edge' && channel === 'edge') return false
  return true
}

export const LabsSection = observer(function LabsSection({
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
  const listed = state?.flags.filter((flag) => flag.listed && flag.visibility !== 'hidden') ?? []
  const channel = state?.channel ?? 'stable'

  return (
    <Section>
      {!state && <p className="settings-prose">Loading Labs features…</p>}
      {state && listed.length === 0 && (
        <p className="settings-prose">No Labs features are available on this install.</p>
      )}
      {/* A flag row is a Row: same two columns, same seam, same measure — it just
          carries a badge. It had its own flex layout and its own sizes. */}
      {listed.map((flag) => {
        const checked = flag.enabled
        const label =
          flag.id === 'command-palette' ? `Search everything (${modChord('K')})` : flag.name
        const showDevBadge = Boolean(state?.devMode && isDevOnlyListed(flag, channel))
        return (
          <Row
            key={flag.id}
            setting="experimental"
            label={label}
            readOnlyValue={checked ? 'On' : 'Off'}
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
              aria-label={label}
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
