import type { PodiumSettings } from '@podium/runtime'
import type { JSX } from 'react'
import { toast } from 'sonner'
import { type ShellDensity, useDensity } from '@/app/density'
import { type ThemeMode, useTheme } from '@/app/theme'
import { Button } from '@/components/ui/button'
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  LINE_HEIGHT_MAX,
  LINE_HEIGHT_MIN,
  TERMINAL_DEFAULTS,
} from '@/features/terminal/appearance'
import { useTerminalAppearance } from '@/features/terminal/use-terminal-appearance'
import { useStickyPromptsPreference } from '@/lib/sticky-prompts'
import { useSettingsRowId } from '../settings-anchors'
import {
  NumberRow,
  Row,
  Section,
  SegmentedRow,
  SwitchRow,
  TextRow,
  ThisDeviceTag,
} from './shared'
import { AccountTipsRow } from './tips'

const THEMES: readonly { value: ThemeMode; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]
const DENSITIES: readonly { value: ShellDensity; label: string }[] = [
  { value: 'balanced', label: 'Comfortable' },
  { value: 'compact', label: 'Compact' },
]
const PROJECT_SORTS = [
  { value: 'lastUsed', label: 'Recent' },
  { value: 'alphabetical', label: 'A–Z' },
  { value: 'custom', label: 'Custom' },
] as const

/** Custom visual controls use the same immediate-save/Undo contract as rows. */
function saveDeviceChoice(save: () => void, undo: () => void): void {
  save()
  toast('Saved', { action: { label: 'Undo', onClick: undo } })
}

export function AppearanceSection({
  settings,
  patch,
}: {
  settings: PodiumSettings
  patch: (patch: Partial<PodiumSettings>) => unknown
}): JSX.Element {
  const { density, setDensity } = useDensity()
  const stickyPrompts = useStickyPromptsPreference()
  return (
    <>
      <ThemeCards />
      <Section title="Interface">
        <SegmentedRow
          label="Density"
          description="Compact fits more rows on screen."
          device
          value={density}
          onChange={setDensity}
          options={DENSITIES}
        />
        <SwitchRow
          label="Keep my last message in view"
          description="Pins your latest message to the top of a conversation while the reply scrolls."
          device
          value={stickyPrompts.enabled}
          onChange={stickyPrompts.setEnabled}
        />
        <SegmentedRow
          label="Sort projects in the sidebar"
          description="Custom is set by dragging projects in the sidebar."
          setting="sidebar.repoSort"
          value={settings.sidebar.repoSort}
          options={PROJECT_SORTS}
          onChange={(repoSort) => patch({ sidebar: { ...settings.sidebar, repoSort } })}
        />
        <AccountTipsRow />
      </Section>
      <TerminalAppearanceRows />
    </>
  )
}

function ThemeCards(): JSX.Element {
  const { mode, setMode } = useTheme()
  const id = useSettingsRowId('Theme')
  return (
    <section>
      <div className="mb-4 flex items-center gap-2">
        <h3 className="settings-h">Theme</h3>
        <ThisDeviceTag />
      </div>
      <fieldset
        id={id}
        tabIndex={id ? -1 : undefined}
        aria-label="Theme"
        className="m-0 grid min-w-0 grid-cols-3 gap-3 border-0 p-0"
      >
        {THEMES.map((theme) => (
          <Button
            key={theme.value}
            type="button"
            variant="ghost"
            aria-pressed={mode === theme.value}
            className="group h-auto min-w-0 flex-col items-stretch gap-2 rounded-lg p-0 text-left hover:bg-transparent"
            onClick={() => {
              if (mode !== theme.value)
                saveDeviceChoice(() => setMode(theme.value), () => setMode(mode))
            }}
          >
            <ThemePreview mode={theme.value} selected={mode === theme.value} />
            <span className="settings-label">{theme.label}</span>
          </Button>
        ))}
      </fieldset>
    </section>
  )
}

/** Fixed swatches preview both palettes even when the surrounding theme changes. */
function ThemePreview({ mode, selected }: { mode: ThemeMode; selected: boolean }): JSX.Element {
  const outline = selected
    ? 'ring-2 ring-primary'
    : 'ring-1 ring-border group-hover:ring-border-strong'
  if (mode === 'system')
    return (
      <span
        aria-hidden="true"
        className={`relative block h-[74px] overflow-hidden rounded-lg ${outline}`}
        style={{ background: 'linear-gradient(115deg, #f2f1ed 50%, #16171a 50%)' }}
      >
        <span
          className="absolute inset-[9px] rounded-[5px]"
          style={{ background: 'linear-gradient(115deg, #fff 50%, #23262d 50%)' }}
        />
      </span>
    )
  const dark = mode === 'dark'
  const line = dark ? 'bg-[#2c3038]' : 'bg-[#e8e6e0]'
  return (
    <span
      aria-hidden="true"
      className={`grid h-[74px] grid-cols-[30%_1fr] overflow-hidden rounded-lg ${outline}`}
    >
      <span className={`flex flex-col gap-[5px] px-[7px] py-[9px] ${dark ? 'bg-[#191a1e]' : 'bg-[#f4f3f0]'}`}>
        <span className={`h-[5px] rounded ${line}`} />
        <span className={`h-[5px] rounded ${line}`} />
        <span className={`h-[5px] rounded ${line}`} />
      </span>
      <span className={`flex flex-col gap-[5px] p-[9px] ${dark ? 'bg-[#23262d]' : 'bg-white'}`}>
        <span className="h-[5px] w-2/5 rounded bg-[#d9b477]" />
        <span className={`h-[5px] rounded ${line}`} />
        <span className={`h-[5px] w-[70%] rounded ${line}`} />
      </span>
    </span>
  )
}

function TerminalAppearanceRows(): JSX.Element {
  const { settings, update } = useTerminalAppearance()
  const isDefault = Object.keys(settings).length === 0
  const background = settings.background ?? TERMINAL_DEFAULTS.background
  return (
    <section>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h3 className="settings-h mb-1.5">Terminal</h3>
          <p className="settings-prose">Applies to running sessions immediately.</p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={isDefault}
          onClick={() =>
            saveDeviceChoice(
              () => update({ fontSize: undefined, fontFamily: undefined, lineHeight: undefined, background: undefined }),
              () => update(settings),
            )
          }
        >
          Restore defaults
        </Button>
      </div>
      <NumberRow
        label="Font size"
        device
        min={FONT_SIZE_MIN}
        max={FONT_SIZE_MAX}
        step={1}
        unit="px"
        placeholder={String(TERMINAL_DEFAULTS.fontSize)}
        value={settings.fontSize}
        emptyValue={undefined}
        onChange={(fontSize) => update({ fontSize: fontSize ?? undefined })}
      />
      <NumberRow
        label="Line height"
        device
        min={LINE_HEIGHT_MIN}
        max={LINE_HEIGHT_MAX}
        step={0.05}
        placeholder={String(TERMINAL_DEFAULTS.lineHeight)}
        value={settings.lineHeight}
        emptyValue={undefined}
        onChange={(lineHeight) => update({ lineHeight: lineHeight ?? undefined })}
      />
      <TextRow
        label="Font"
        device
        placeholder="System monospace"
        value={settings.fontFamily ?? ''}
        onChange={(fontFamily) => update({ fontFamily: fontFamily.trim() || undefined })}
      />
      <Row label="Background" device>
        <label className="relative inline-flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-1.5 focus-within:ring-2 focus-within:ring-ring">
          <input
            type="color"
            aria-label="Terminal background color"
            className="size-6 cursor-pointer rounded border border-border bg-transparent p-0"
            value={background}
            onChange={(event) => {
              const next = event.target.value
              if (next !== background)
                saveDeviceChoice(() => update({ background: next }), () => update({ background: settings.background }))
            }}
          />
          <span className="settings-value">{background}</span>
        </label>
      </Row>
    </section>
  )
}
