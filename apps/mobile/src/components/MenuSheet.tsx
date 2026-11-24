import { useEffect, useRef, useState } from 'react'
import { ActionSheet, type SheetAction } from './ActionSheet'
import { isMenuSection, type ScreenMenuEntry, type ScreenMenuSection } from './screen-actions'

/**
 * Android and web draw a header menu ({@link ScreenMenuEntry}s, the same list
 * iOS hands to its native pull-down) as the app's action sheet. Inline sections
 * flatten into the list; a submenu is one row that opens its entries as the
 * next page.
 */
export function MenuSheet({
  visible,
  title,
  entries,
  onClose,
  testID,
}: {
  visible: boolean
  title?: string
  entries: readonly ScreenMenuEntry[]
  onClose: () => void
  testID?: string
}) {
  // The open submenu, by title: its rows are read from the live entries on
  // every render, so a fact that changes while the page is up redraws it.
  const [page, setPage] = useState<string | null>(null)
  useEffect(() => {
    if (!visible) setPage(null)
  }, [visible])
  // The sheet runs a row's action, then reports its own close. A row that
  // opened the next page marks the hand-off so that close does not end the menu.
  const handedOff = useRef(false)
  const submenu = page === null ? undefined : findSubmenu(entries, page)
  const heading = submenu ? submenu.title : title
  return (
    <ActionSheet
      key={submenu ? `page:${page}` : 'root'}
      visible={visible}
      {...(heading ? { title: heading } : {})}
      {...(testID ? { testID } : {})}
      actions={menuSheetActions(submenu?.items ?? entries, (next) => {
        handedOff.current = true
        setPage(next)
      })}
      onClose={() => {
        if (handedOff.current) {
          handedOff.current = false
          return
        }
        onClose()
      }}
    />
  )
}

function findSubmenu(
  entries: readonly ScreenMenuEntry[],
  title: string,
): ScreenMenuSection | undefined {
  for (const entry of entries) {
    if (!isMenuSection(entry)) continue
    if (entry.submenu && entry.title === title) return entry
    const nested = findSubmenu(entry.items, title)
    if (nested) return nested
  }
  return undefined
}

/** The sheet rows a menu draws as, in order; a submenu row opens its page by title. */
export function menuSheetActions(
  entries: readonly ScreenMenuEntry[],
  openPage: (title: string) => void,
): SheetAction[] {
  return entries.flatMap((entry): SheetAction[] => {
    if (!isMenuSection(entry)) {
      return [
        {
          label: entry.label,
          ...(entry.hint ? { hint: entry.hint } : {}),
          ...(entry.selected !== undefined ? { selected: entry.selected } : {}),
          ...(entry.destructive ? { destructive: true } : {}),
          ...(entry.disabled ? { disabled: true } : {}),
          onPress: entry.onPress,
        },
      ]
    }
    if (!entry.submenu) return menuSheetActions(entry.items, openPage)
    const title = entry.title ?? ''
    return [{ label: `${title}…`, onPress: () => openPage(title) }]
  })
}
