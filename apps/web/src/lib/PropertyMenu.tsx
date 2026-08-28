import { Check } from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { filterPropertyOptions, groupPropertyOptions } from './property-menu'

export interface PropertyOption {
  value: string
  label: string
  icon?: ReactNode
  /** When set, options that share a group render under one heading. */
  group?: string
  /** Split runs WITHOUT naming them: consecutive options sharing a `groupKey`
   *  are separated by a rule and no heading. The status picker uses this — its
   *  categories are carried by the glyphs (POD-1074), and writing the category
   *  out would put a word like "Closed" over `Done`, fusing the two endings
   *  Linear deliberately keeps apart. Falls back to `group` when absent. */
  groupKey?: string
}

/** Linear-style property picker: dropdown with type-ahead + optional free text. */
export function PropertyMenu({
  trigger,
  options,
  selectedValue,
  onSelect,
  allowFreeText = false,
  placeholder = 'Filter…',
  footnote,
}: {
  trigger: ReactNode
  options: PropertyOption[]
  selectedValue?: string
  onSelect: (value: string) => void
  allowFreeText?: boolean
  placeholder?: string
  /**
   * A line under the options saying what is NOT in them, and why (POD-2700).
   *
   * A machine picker that silently drops the rows that cannot do the job is
   * indistinguishable from a broken filter — which is how an operator ended up
   * staring at a menu with one useless entry and no explanation. The menu states
   * its case here instead of shrinking without comment.
   */
  footnote?: string
}): JSX.Element {
  const [query, setQuery] = useState('')
  const filtered = filterPropertyOptions(options, query)
  const exact = options.some((o) => o.label.toLowerCase() === query.trim().toLowerCase())
  return (
    <DropdownMenu
      // Non-modal so the menu doesn't lock body scroll — on mobile the scroll
      // lock otherwise fought the type-ahead input's focus (Task 7 review).
      modal={false}
      onOpenChange={(open) => {
        if (!open) setQuery('')
      }}
    >
      <DropdownMenuTrigger render={trigger as JSX.Element} />
      <DropdownMenuContent align="start" className="w-56">
        {/* Carved into the panel rather than raised on it (DESIGN.md §4): the
            panel is --chip, so the field takes the window's own ground. */}
        <div className="mx-[5px] mb-[5px]">
          <Input
            autoFocus
            value={query}
            placeholder={placeholder}
            className="h-[26px] rounded-md border-hairline-soft bg-background text-[11.5px] placeholder:text-text-faint focus-visible:border-hairline-soft focus-visible:ring-2 focus-visible:ring-ring/40 md:text-[11.5px]"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Let Escape propagate so Base UI closes the menu; swallow the
              // rest so the menu's label-typeahead doesn't steal keystrokes.
              if (e.key !== 'Escape') e.stopPropagation()
            }}
          />
        </div>
        {groupPropertyOptions(filtered).map((g, i) => (
          <DropdownMenuGroup key={g.group ?? `ungrouped-${String(i)}`}>
            {i > 0 ? <DropdownMenuSeparator /> : null}
            {g.group ? <DropdownMenuLabel>{g.group}</DropdownMenuLabel> : null}
            {g.options.map((o) => (
              <DropdownMenuItem key={o.value} onClick={() => onSelect(o.value)}>
                {o.icon}
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {selectedValue === o.value && (
                  <Check className="ml-auto size-3 flex-none text-text-faint" aria-hidden="true" />
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        ))}
        {allowFreeText && query.trim() && !exact && (
          <DropdownMenuItem onClick={() => onSelect(query.trim())}>
            Use “{query.trim()}”
          </DropdownMenuItem>
        )}
        {footnote ? (
          <p className="px-2 pt-1.5 pb-1 text-[10.5px] leading-snug text-text-faint">{footnote}</p>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
