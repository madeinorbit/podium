import { type KeyboardEvent, useRef } from 'react'

interface TypeaheadOption {
  value: string
  label: string
  disabled?: boolean
}

/** Native-select typing while a picker trigger has focus and its menu is closed. */
export function useSelectTypeahead({
  enabled,
  options,
  selectedValue,
  onSelect,
}: {
  enabled: boolean
  options: TypeaheadOption[]
  selectedValue?: string
  onSelect: (value: string) => void
}) {
  const search = useRef({ query: '', at: 0 })
  const reset = () => {
    search.current = { query: '', at: 0 }
  }
  return {
    onBlur: reset,
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (
        !enabled ||
        event.defaultPrevented ||
        event.target !== event.currentTarget ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.nativeEvent.isComposing ||
        event.key.length !== 1
      ) {
        reset()
        return
      }

      const previous = event.timeStamp - search.current.at < 1000 ? search.current.query : ''
      // Space still opens the menu unless it is part of a name being typed.
      if (event.key === ' ' && !previous) return
      const key = event.key.toLowerCase()
      let query = previous + key
      if ([...query].every((character) => character === key)) query = key
      search.current = { query, at: event.timeStamp }
      event.preventDefault()

      const selected = options.findIndex((option) => option.value === selectedValue)
      // Single letters cycle; longer prefixes keep the current match first.
      const start = Math.max(0, selected + (query.length === 1 ? 1 : 0))
      for (let offset = 0; offset < options.length; offset++) {
        const option = options[(start + offset) % options.length]
        if (
          option &&
          !option.disabled &&
          option.label.trimStart().toLowerCase().startsWith(query)
        ) {
          if (option.value !== selectedValue) onSelect(option.value)
          break
        }
      }
    },
  }
}
