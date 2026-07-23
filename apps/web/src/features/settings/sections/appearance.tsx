import type { JSX } from 'react'
import { type ThemeMode, type ThemePreset, useTheme } from '@/app/theme'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useStickyPromptsPreference } from '@/features/chat/sticky-prompts'
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  LINE_HEIGHT_MAX,
  LINE_HEIGHT_MIN,
  TERMINAL_DEFAULTS,
} from '@/features/terminal/appearance'
import { useTerminalAppearance } from '@/features/terminal/use-terminal-appearance'
import { Row, Section } from './shared'

/** Theme + light/dark switcher. Theme state is UI-local (not part of the settings
 *  blob), so it applies instantly via useTheme and persists on its own. */
export function AppearanceSection(): JSX.Element {
  const { preset, mode, setPreset, setMode } = useTheme()
  const stickyPrompts = useStickyPromptsPreference()
  // 'superade' is the canonical Podium look (DESIGN.md), so it carries the
  // product name; the older 'podium' preset stays available as "Classic".
  const presets: { value: ThemePreset; label: string }[] = [
    { value: 'superade', label: 'Podium' },
    { value: 'podium', label: 'Classic' },
    { value: 'shadcn', label: 'shadcn' },
  ]
  const modes: { value: ThemeMode; label: string }[] = [
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
    { value: 'system', label: 'System' },
  ]
  return (
    <Section
      title="Appearance"
      hint="Theme and light/dark mode. Applies instantly and is remembered on this device."
    >
      <Row label="Theme">
        <div className="flex gap-1">
          {presets.map((p) => (
            <Button
              key={p.value}
              type="button"
              size="sm"
              variant={preset === p.value ? 'default' : 'outline'}
              aria-pressed={preset === p.value}
              onClick={() => setPreset(p.value)}
            >
              {p.label}
            </Button>
          ))}
        </div>
      </Row>
      <Row label="Mode">
        <div className="flex gap-1">
          {modes.map((m) => (
            <Button
              key={m.value}
              type="button"
              size="sm"
              variant={mode === m.value ? 'default' : 'outline'}
              aria-pressed={mode === m.value}
              onClick={() => setMode(m.value)}
            >
              {m.label}
            </Button>
          ))}
        </div>
      </Row>
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
  const { settings, update } = useTerminalAppearance()
  const isDefault =
    settings.fontSize === undefined &&
    settings.fontFamily === undefined &&
    settings.lineHeight === undefined &&
    settings.background === undefined
  return (
    <>
      <h4 className="mt-3 mb-0.5 font-medium text-[13px] text-foreground">Terminal</h4>
      <p className="mb-2 max-w-[60ch] text-[12px] text-muted-foreground">
        Font and colors of the native terminal panels. Applies to running sessions instantly.
      </p>
      <Row label="Font size">
        <NumberField
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          step={1}
          placeholder={String(TERMINAL_DEFAULTS.fontSize)}
          stored={settings.fontSize}
          onCommit={(n) => update({ fontSize: n })}
        />
      </Row>
      <Row label="Line height">
        <NumberField
          min={LINE_HEIGHT_MIN}
          max={LINE_HEIGHT_MAX}
          step={0.05}
          placeholder={String(TERMINAL_DEFAULTS.lineHeight)}
          stored={settings.lineHeight}
          onCommit={(n) => update({ lineHeight: n })}
        />
      </Row>
      <Row label="Font family">
        <Input
          type="text"
          className="max-w-[320px]"
          placeholder="System monospace (default)"
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
            value={settings.background ?? TERMINAL_DEFAULTS.background}
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
          className="mt-1 text-muted-foreground"
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
    </>
  )
}
