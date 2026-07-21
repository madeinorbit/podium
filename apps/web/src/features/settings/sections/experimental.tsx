/**
 * Settings → Experimental [spec:SP-f4b9]: listed feature flags with user
 * toggles. Listing/lock state comes from `features.state`; enablement edits
 * patch the settings blob and ride the page Save button.
 */
import type { PodiumSettings } from '@podium/runtime'
import type { JSX } from 'react'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useFeaturesState } from '@/lib/use-feature'
import { Section } from './shared'

interface FeatureFlagWire {
  id: string
  name: string
  description: string
  visibility: 'hidden' | 'edge' | 'stable'
  listed: boolean
  enabled: boolean
  source: 'config' | 'user' | 'default'
  locked: boolean
}

/** Listed only because of dev mode (invisible on this channel in release builds). */
function isDevOnlyListed(flag: FeatureFlagWire, channel: 'stable' | 'edge'): boolean {
  if (flag.visibility === 'stable') return false
  if (flag.visibility === 'edge' && channel === 'edge') return false
  return true
}

export function ExperimentalSection({
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
  // Shared module cache (same as useFeature) — one features.state fetch per app load;
  // re-fetched after settings Save via invalidateFeatures [spec:SP-f4b9].
  const state = useFeaturesState()
  const listed = state?.flags.filter((f) => f.listed) ?? []
  const channel = state?.channel ?? 'stable'
  const channelLabel = channel === 'edge' ? 'edge' : 'stable'

  return (
    <Section
      title="Experimental"
      hint={`Pre-release features for this install (update channel: ${channelLabel}). Changes apply after Save.`}
    >
      {!state && (
        <p className="text-[12px] text-muted-foreground">Loading experimental features…</p>
      )}
      {state && listed.length === 0 && (
        <p className="text-[12px] text-muted-foreground">
          No experimental features are available on this install.
        </p>
      )}
      {listed.map((flag) => {
        const checked = flag.locked
          ? flag.enabled
          : (settings.experimental?.[flag.id] ?? false)
        const showDevBadge = Boolean(state?.devMode && isDevOnlyListed(flag, channel))
        return (
          <div key={flag.id} className="flex items-start gap-2.5 py-1.5 text-[13px]">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5 text-foreground">
                <span>{flag.name}</span>
                {showDevBadge && (
                  <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                    Dev
                  </Badge>
                )}
              </div>
              <p className="mt-0.5 max-w-[60ch] text-[12px] text-muted-foreground">
                {flag.description}
              </p>
              {flag.locked && (
                <p className="mt-0.5 text-[11px] text-muted-foreground/80">Set by config file</p>
              )}
            </div>
            <Switch
              className="mt-0.5 flex-none"
              checked={checked}
              disabled={flag.locked}
              onCheckedChange={(next) =>
                patch({
                  experimental: { ...settings.experimental, [flag.id]: next },
                })
              }
            />
          </div>
        )
      })}
      <div className="mt-6 border-hairline-soft border-t pt-4">
        <h4 className="mb-0.5 font-semibold text-[12.5px] text-text-strong">Reset settings</h4>
        <p className="mb-2 max-w-[58ch] text-[11.5px] text-text-dim">
          Replaces every setting on this page and all others with Podium&apos;s defaults. Nothing
          is saved until you confirm the change in the save bar.
        </p>
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
          <Button type="button" variant="outline" size="sm" onClick={() => setConfirmingReset(true)}>
            Reset to defaults…
          </Button>
        )}
      </div>
    </Section>
  )
}
