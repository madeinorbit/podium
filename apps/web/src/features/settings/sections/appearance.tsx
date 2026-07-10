import type { JSX } from 'react'
import { type ThemeMode, type ThemePreset, useTheme } from '@/app/theme'
import { Button } from '@/components/ui/button'
import { Row, Section } from './shared'

/** Theme + light/dark switcher. Theme state is UI-local (not part of the settings
 *  blob), so it applies instantly via useTheme and persists on its own. */
export function AppearanceSection(): JSX.Element {
  const { preset, mode, setPreset, setMode } = useTheme()
  const presets: { value: ThemePreset; label: string }[] = [
    { value: 'podium', label: 'Podium' },
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
    </Section>
  )
}
