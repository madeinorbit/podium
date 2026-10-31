import { useCallback, useState } from 'react'
import type { ActivityDisclosureProps } from '../values/activity-display'

/** One disclosure contract for activity members on web and mobile. */
export function useActivityDisclosure({
  forceOpen = false,
  onOpenChange,
}: ActivityDisclosureProps = {}) {
  const [userOpen, setUserOpen] = useState(false)
  const setOpen = useCallback(
    (open: boolean) => {
      setUserOpen(open)
      onOpenChange?.(open)
    },
    [onOpenChange],
  )
  const toggle = useCallback(() => setOpen(!userOpen), [setOpen, userOpen])
  return { userOpen, open: userOpen || forceOpen, setOpen, toggle }
}
