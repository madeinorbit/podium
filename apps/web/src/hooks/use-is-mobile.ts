import { useEffect, useState } from 'react'

/** True below the 768px mobile breakpoint. Shared so dialogs can pick the
 *  keyboard-safe modal mode (trap-focus) on mobile. */
export function useIsMobile(): boolean {
  const [m, setM] = useState(() => window.matchMedia('(max-width: 768px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)')
    const on = () => setM(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return m
}
