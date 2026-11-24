import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react'
import { AppState } from 'react-native'
import { useProjectionFocus } from '../client/projection-focus'

const VisibleContext = createContext(true)
const CoverContext = createContext<{ visible: boolean; cover(): () => void } | null>(null)

/** Visibility is presentation state. A mounted pager page or prefetched row
 * can keep its content without observing time or allocating frame mappers. */
export function VisibleContent({ visible, children }: { visible: boolean; children: ReactNode }) {
  const parent = useContext(VisibleContext)
  return <VisibleContext value={parent && visible}>{children}</VisibleContext>
}

export function useContentVisible(): boolean {
  const visible = useContext(VisibleContext)
  const focused = useProjectionFocus()
  return visible && focused
}

const subscribeAppState = (changed: () => void) => {
  const subscription = AppState.addEventListener('change', changed)
  return () => subscription.remove()
}
const appActive = () => AppState.currentState === 'active'

/** Polls need a React lifetime on both navigator focus and app foreground. */
export function useContentActive(): boolean {
  const visible = useContentVisible()
  const active = useSyncExternalStore(subscribeAppState, appActive, appActive)
  return visible && active
}

/** A screen owns its modal coverage. The sheet itself gets the visibility
 * before its own cover, so time can run inside the sheet but not behind it. */
export function ContentActivity({ children }: { children: ReactNode }) {
  const visible = useContentVisible()
  const [covers, setCovers] = useState(0)
  const cover = useCallback(() => {
    setCovers((count) => count + 1)
    return () => setCovers((count) => count - 1)
  }, [])
  const scope = useMemo(() => ({ visible, cover }), [visible, cover])
  return (
    <CoverContext value={scope}>
      <VisibleContext value={visible && covers === 0}>{children}</VisibleContext>
    </CoverContext>
  )
}

export function SheetActivity({ visible, children }: { visible: boolean; children: ReactNode }) {
  const scope = useContext(CoverContext)
  const parent = useContentVisible()
  const cover = scope?.cover
  useEffect(() => (visible ? cover?.() : undefined), [visible, cover])
  return (
    <VisibleContext value={visible && (scope?.visible ?? parent)}>
      <ContentActivity>{children}</ContentActivity>
    </VisibleContext>
  )
}
