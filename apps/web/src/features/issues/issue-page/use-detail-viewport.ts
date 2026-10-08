import { useSyncExternalStore } from 'react'
const query = '(min-width: 768px)'
const snapshot = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : true
const subscribe = (changed: () => void) => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
  const media = window.matchMedia(query)
  if (typeof media.addEventListener !== 'function') return () => {}
  media.addEventListener('change', changed)
  return () => media.removeEventListener('change', changed)
}
export const useDetailDesktop = () => useSyncExternalStore(subscribe, snapshot, () => true)
