import { type ReactElement, useState } from 'react'
import type { StyleProp, ViewStyle } from 'react-native'
import { ActionSheet } from '../ActionSheet'

export interface ComposeMenuItem {
  id: string
  label: string
  subtitle?: string
  symbol?: string
  selected?: boolean
  disabled?: boolean
  inline?: boolean
  items?: readonly ComposeMenuItem[]
  onPress?: () => void
}

export interface ComposeMenuProps {
  label: string
  items: readonly ComposeMenuItem[]
  /** With a primary action, a tap acts and a hold opens the menu, as in Mail. */
  onPrimaryAction?: () => void
  disabled?: boolean
  style?: StyleProp<ViewStyle>
  children: (onPress?: () => void, onLongPress?: () => void) => ReactElement
}

/** The same ActionSheet fallback used by the app's native pickers. */
export function ComposeMenu({
  label,
  items,
  children,
  disabled,
  onPrimaryAction,
}: ComposeMenuProps) {
  const [page, setPage] = useState<{ label: string; items: readonly ComposeMenuItem[] } | null>(
    null,
  )
  const open = () => {
    if (disabled) return
    setPage({ label, items })
  }
  const close = () => {
    setPage(null)
  }
  const rows = page?.items.flatMap((item) => (item.inline ? (item.items ?? []) : [item])) ?? []
  return (
    <>
      {children(
        onPrimaryAction
          ? () => {
              if (!disabled) onPrimaryAction()
            }
          : open,
        open,
      )}
      <ActionSheet
        key={page?.label ?? label}
        visible={page !== null}
        title={page?.label}
        actions={rows.map((item) => ({
          label: item.label,
          hint: item.subtitle,
          selected: item.selected,
          disabled: item.disabled,
          onPress: () => {
            if (item.items) setPage({ label: item.label, items: item.items })
            else {
              close()
              item.onPress?.()
            }
          },
        }))}
        onClose={() => {
          setPage((current) => {
            if (current !== page) return current
            return null
          })
        }}
      />
    </>
  )
}
