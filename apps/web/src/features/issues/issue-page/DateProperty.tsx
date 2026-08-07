/**
 * A DATE, PICKED THE APP'S WAY (POD-591).
 *
 * The rail used to carry two bare `<input type="date">` controls and a bare
 * `<input type="number">`. A browser's own date field is the single loudest
 * "this is a web page in a frame" tell an app can have — it renders
 * `mm/dd/yyyy` in the browser's locale, its own calendar glyph, its own popover
 * chrome, none of which belong to this design system — and both of them sat in
 * the resting rail of every task, almost always empty.
 *
 * What replaces them is a normal `PropertyMenu` trigger like every other row in
 * the rail, opening a small panel of the answers an operator actually gives —
 * today, tomorrow, next week, clear — with the native picker kept INSIDE as the
 * escape hatch for a specific date. The native control is not banned, it is just
 * no longer chrome: it appears once you have said "some other day".
 */
import { CalendarDays, X } from 'lucide-react'
import type { JSX } from 'react'
import { useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { TriggerButton } from './property-chrome'

/** `YYYY-MM-DD` for a day offset from today, in LOCAL time — the operator means
 *  their own tomorrow, and `toISOString()` would hand back UTC's. */
function dayOffset(days: number): string {
  const at = new Date()
  at.setDate(at.getDate() + days)
  const month = String(at.getMonth() + 1).padStart(2, '0')
  const day = String(at.getDate()).padStart(2, '0')
  return `${at.getFullYear()}-${month}-${day}`
}

/** Short, unambiguous display for a stored date (`7 Aug`, `7 Aug 2027`). */
export function formatDateValue(value: string): string {
  const at = new Date(`${value.slice(0, 10)}T00:00:00`)
  if (Number.isNaN(at.getTime())) return value
  const sameYear = at.getFullYear() === new Date().getFullYear()
  return at.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}

const QUICK: { label: string; days: number }[] = [
  { label: 'Today', days: 0 },
  { label: 'Tomorrow', days: 1 },
  { label: 'Next week', days: 7 },
  { label: 'In a month', days: 30 },
]

export function DateProperty({
  value,
  placeholder,
  ariaLabel,
  disabled,
  onSelect,
  onClear,
}: {
  /** Stored ISO date (or datetime — only the date part is read), or null. */
  value: string | null | undefined
  placeholder: string
  ariaLabel: string
  disabled?: boolean
  onSelect: (isoDate: string) => void
  onClear?: () => void
}): JSX.Element {
  const [custom, setCustom] = useState(false)
  const set = (next: string): void => {
    setCustom(false)
    onSelect(next)
  }
  return (
    <DropdownMenu modal={false} onOpenChange={(open) => !open && setCustom(false)}>
      <DropdownMenuTrigger
        render={
          <TriggerButton disabled={disabled} aria-label={ariaLabel}>
            <CalendarDays size={12} aria-hidden="true" className="flex-none opacity-70" />
            {value ? (
              <span className="truncate">{formatDateValue(value)}</span>
            ) : (
              <span className="text-text-faint">{placeholder}</span>
            )}
          </TriggerButton>
        }
      />
      <DropdownMenuContent align="start" className="w-48">
        {QUICK.map((quick) => (
          <DropdownMenuItem key={quick.label} onClick={() => set(dayOffset(quick.days))}>
            {quick.label}
            <span className="ml-auto font-mono text-[9px] text-text-faint">
              {formatDateValue(dayOffset(quick.days))}
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {custom ? (
          <div className="p-1">
            <Input
              type="date"
              autoFocus
              aria-label={ariaLabel}
              defaultValue={value ? value.slice(0, 10) : ''}
              className="h-7 text-[12px]"
              onKeyDown={(e) => {
                if (e.key !== 'Escape') e.stopPropagation()
              }}
              onChange={(e) => e.currentTarget.value && set(e.currentTarget.value)}
            />
          </div>
        ) : (
          <DropdownMenuItem
            closeOnClick={false}
            onClick={(event) => {
              event.preventDefault()
              setCustom(true)
            }}
          >
            Pick a date…
          </DropdownMenuItem>
        )}
        {value && onClear && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onClear}>
              <X size={12} aria-hidden="true" /> Clear
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The estimate field, as a menu of the sizes people actually pick plus a free
 *  entry — the bare number spinner it replaces was the rail's other native
 *  control, and it asked for minutes with no sense of scale. */
export function EstimateProperty({
  value,
  disabled,
  onSelect,
  onClear,
}: {
  value: number | null | undefined
  disabled?: boolean
  onSelect: (minutes: number) => void
  onClear: () => void
}): JSX.Element {
  const [custom, setCustom] = useState(false)
  const choices = [15, 30, 60, 120, 240, 480]
  const label = (minutes: number): string =>
    minutes < 60 ? `${minutes}m` : `${minutes / 60}h`.replace('.5h', '½h')
  return (
    <DropdownMenu modal={false} onOpenChange={(open) => !open && setCustom(false)}>
      <DropdownMenuTrigger
        render={
          <TriggerButton disabled={disabled} aria-label="Estimate">
            {value != null ? (
              <span className="font-mono tabular-nums">{label(value)}</span>
            ) : (
              <span className="text-text-faint">Estimate…</span>
            )}
          </TriggerButton>
        }
      />
      <DropdownMenuContent align="start" className="w-40">
        {choices.map((minutes) => (
          <DropdownMenuItem key={minutes} onClick={() => onSelect(minutes)}>
            {label(minutes)}
            <span className="ml-auto font-mono text-[9px] text-text-faint">{minutes}m</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {custom ? (
          <div className="p-1">
            <Input
              type="number"
              min={0}
              autoFocus
              aria-label="Estimate (minutes)"
              defaultValue={value ?? ''}
              placeholder="minutes"
              className="h-7 text-[12px]"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  e.currentTarget.blur()
                } else if (e.key !== 'Escape') e.stopPropagation()
              }}
              onBlur={(e) => {
                const raw = e.currentTarget.value.trim()
                const n = Number(raw)
                if (raw !== '' && Number.isInteger(n) && n !== (value ?? null)) onSelect(n)
                setCustom(false)
              }}
            />
          </div>
        ) : (
          <DropdownMenuItem
            closeOnClick={false}
            onClick={(event) => {
              event.preventDefault()
              setCustom(true)
            }}
          >
            Other…
          </DropdownMenuItem>
        )}
        {value != null && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onClear}>
              <X size={12} aria-hidden="true" /> Clear
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
