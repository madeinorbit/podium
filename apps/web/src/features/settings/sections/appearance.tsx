import type { JSX } from 'react'
import { type ShellDensity, useDensity } from '@/app/density'
import { type ThemeAppearance, type ThemeMode, useTheme } from '@/app/theme'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  LINE_HEIGHT_MAX,
  LINE_HEIGHT_MIN,
  TERMINAL_DEFAULTS,
} from '@/features/terminal/appearance'
import { useTerminalAppearance } from '@/features/terminal/use-terminal-appearance'
import { isLinuxPlatform } from '@/lib/nativeDesktop'
import { useStickyPromptsPreference } from '@/lib/sticky-prompts'
import { useFeature } from '@/lib/use-feature'
import { Row, Section, Subsection } from './shared'

/** Light/dark switcher. Theme state is UI-local (not part of the settings blob),
 *  so it applies instantly via useTheme and persists on its own. */
export function AppearanceSection(): JSX.Element {
  const { mode, setMode, appearance, setAppearance } = useTheme()
  const { density, setDensity } = useDensity()
  // The Omarchy profile is offered where Omarchy runs and nowhere else — see
  // isLinuxPlatform. Read once per render rather than held in state: the
  // platform cannot change under a running window.
  const omarchyOffered = isLinuxPlatform()
  const profiles: { value: ThemeAppearance; label: string }[] = [
    { value: 'podium', label: 'Podium' },
    { value: 'omarchy', label: 'Omarchy' },
  ]
  const densityEnabled = useFeature('shell-density')
  const stickyPrompts = useStickyPromptsPreference()
  const modes: { value: ThemeMode; label: string }[] = [
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
    { value: 'system', label: 'System' },
  ]
  const densities: { value: ShellDensity; label: string }[] = [
    { value: 'balanced', label: 'Balanced' },
    { value: 'compact', label: 'Compact' },
  ]
  const omarchyOn = appearance === 'omarchy'
  return (
    <Section
      title="Appearance"
      hint="Choose light, dark, or follow your system. Remembered on this device."
    >
      {omarchyOffered && (
        <Row
          label="Profile"
          description="Omarchy dresses the window for the Omarchy desktop — Tokyo Night, square corners, no title-bar controls, because Hyprland draws the frame. One dark palette, so the mode above does not apply while it is on. This device only."
        >
          <div className="flex gap-1">
            {profiles.map((p) => (
              <Button
                key={p.value}
                type="button"
                size="sm"
                variant={appearance === p.value ? 'default' : 'outline'}
                aria-pressed={appearance === p.value}
                onClick={() => setAppearance(p.value)}
              >
                {p.label}
              </Button>
            ))}
          </div>
        </Row>
      )}
      <Row
        label="Mode"
        // Omarchy has one palette and no paper counterpart, so the switch is
        // disabled rather than hidden: hiding it would leave no sign of where
        // the light/dark choice went, and the stored mode is still there —
        // turning the profile off returns the operator to it.
        description={omarchyOn ? 'The Omarchy profile is dark only.' : undefined}
      >
        <div className="flex gap-1">
          {modes.map((m) => (
            <Button
              key={m.value}
              type="button"
              size="sm"
              variant={mode === m.value ? 'default' : 'outline'}
              aria-pressed={mode === m.value}
              disabled={omarchyOn}
              onClick={() => setMode(m.value)}
            >
              {m.label}
            </Button>
          ))}
        </div>
      </Row>
      {densityEnabled && (
        <Row
          label="Density"
          description="Balanced prioritizes readable shell typography and a calm scan. Compact fits more work on screen. This device only."
        >
          <div className="flex gap-1">
            {densities.map((option) => (
              <Button
                key={option.value}
                type="button"
                size="sm"
                variant={density === option.value ? 'default' : 'outline'}
                aria-pressed={density === option.value}
                onClick={() => setDensity(option.value)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </Row>
      )}
      <Row
        label="Sticky prompts"
        description="Keep the current operator prompt visible while its response scrolls. This device only."
      >
        <Switch
          aria-label="Sticky prompts"
          checked={stickyPrompts.enabled}
          onCheckedChange={stickyPrompts.setEnabled}
        />
      </Row>
      <TerminalAppearanceRows />
    </Section>
  )
}

/**
 * A numeric setting that commits on blur/Enter, NOT per keystroke — committing
 * mid-typing would clamp intermediate values (typing "1" en route to "16"
 * snaps to the minimum) and visibly fight the user. Uncontrolled while
 * focused; `key` re-seeds it when the stored value changes elsewhere
 * (another tab, the reset button). Empty commits back to the default.
 */
function NumberField({
  min,
  max,
  step,
  placeholder,
  stored,
  onCommit,
}: {
  min: number
  max: number
  step: number
  placeholder: string
  stored: number | undefined
  onCommit: (n: number | undefined) => void
}): JSX.Element {
  const commit = (raw: string): void => {
    if (raw.trim() === '') {
      onCommit(undefined)
      return
    }
    const n = Number.parseFloat(raw)
    if (Number.isFinite(n)) onCommit(Math.min(max, Math.max(min, n)))
  }
  return (
    <Input
      key={stored ?? 'default'}
      type="number"
      className="w-24"
      min={min}
      max={max}
      step={step}
      placeholder={placeholder}
      defaultValue={stored ?? ''}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit(e.currentTarget.value)
      }}
    />
  )
}

/**
 * Terminal appearance (native agent/shell panels): font size/family, line
 * height, background. Device-local like the theme; applies to LIVE terminals
 * instantly (no remount, the PTY keeps running). Empty inputs = the default.
 */
function TerminalAppearanceRows(): JSX.Element {
  const { settings, profileDefaults, update } = useTerminalAppearance()
  // The placeholders say what an EMPTY field will actually do, which under an
  // appearance that supplies its own terminal ground and face is not the
  // terminal-client default (POD-1531). A placeholder reading "13" beside a
  // terminal drawing at 14 is a settings page lying about the thing it edits.
  const effective = { ...TERMINAL_DEFAULTS, ...profileDefaults }
  const isDefault =
    settings.fontSize === undefined &&
    settings.fontFamily === undefined &&
    settings.lineHeight === undefined &&
    settings.background === undefined
  return (
    <Subsection
      title="Terminal"
      hint="Font and colors of the native terminal panels. Applies to running sessions instantly."
    >
      <Row label="Font size">
        <NumberField
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          step={1}
          placeholder={String(effective.fontSize)}
          stored={settings.fontSize}
          onCommit={(n) => update({ fontSize: n })}
        />
      </Row>
      <Row label="Line height">
        <NumberField
          min={LINE_HEIGHT_MIN}
          max={LINE_HEIGHT_MAX}
          step={0.05}
          placeholder={String(effective.lineHeight)}
          stored={settings.lineHeight}
          onCommit={(n) => update({ lineHeight: n })}
        />
      </Row>
      <Row label="Font family">
        <Input
          type="text"
          className="max-w-[320px]"
          placeholder={
            profileDefaults.fontFamily
              ? `${profileDefaults.fontFamily} (default)`
              : 'System monospace (default)'
          }
          value={settings.fontFamily ?? ''}
          onChange={(e) => update({ fontFamily: e.target.value || undefined })}
        />
      </Row>
      <Row label="Background">
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label="Terminal background color"
            className="h-7 w-10 cursor-pointer rounded border border-border bg-transparent"
            value={settings.background ?? effective.background}
            onChange={(e) => update({ background: e.target.value })}
          />
          {settings.background !== undefined && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => update({ background: undefined })}
            >
              Reset
            </Button>
          )}
        </div>
      </Row>
      {!isDefault && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="mt-3 text-muted-foreground"
          onClick={() =>
            update({
              fontSize: undefined,
              fontFamily: undefined,
              lineHeight: undefined,
              background: undefined,
            })
          }
        >
          Reset terminal appearance to defaults
        </Button>
      )}
    </Subsection>
  )
}
