import type { JSX, ReactNode } from 'react'
import { useState } from 'react'
import { Check } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { filterPropertyOptions } from './property-menu'

export interface PropertyOption {
  value: string
  label: string
  icon?: ReactNode
}

/** Linear-style property picker: dropdown with type-ahead + optional free text. */
export function PropertyMenu({
  trigger,
  options,
  selectedValue,
  onSelect,
  allowFreeText = false,
  placeholder = 'Filter…',
}: {
  trigger: ReactNode
  options: PropertyOption[]
  selectedValue?: string
  onSelect: (value: string) => void
  allowFreeText?: boolean
  placeholder?: string
}): JSX.Element {
  const [query, setQuery] = useState('')
  const filtered = filterPropertyOptions(options, query)
  const exact = options.some((o) => o.label.toLowerCase() === query.trim().toLowerCase())
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (!open) setQuery('')
      }}
    >
      <DropdownMenuTrigger render={trigger as JSX.Element} />
      <DropdownMenuContent align="start" className="w-56">
        <div className="p-1">
          <Input
            autoFocus
            value={query}
            placeholder={placeholder}
            className="h-7"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Let Escape propagate so Base UI closes the menu; swallow the
              // rest so the menu's label-typeahead doesn't steal keystrokes.
              if (e.key !== 'Escape') e.stopPropagation()
            }}
          />
        </div>
        {filtered.map((o) => (
          <DropdownMenuItem key={o.value} onClick={() => onSelect(o.value)}>
            {o.icon}
            <span className="min-w-0 flex-1 truncate">{o.label}</span>
            {selectedValue === o.value && <Check size={13} aria-hidden="true" />}
          </DropdownMenuItem>
        ))}
        {allowFreeText && query.trim() && !exact && (
          <DropdownMenuItem onClick={() => onSelect(query.trim())}>
            Use “{query.trim()}”
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
