import { useUi } from '@podium/client-core/react'
import {
  type FileScrollPosition,
  readFileScrollPosition,
  writeFileScrollPosition,
} from '@podium/client-core/ui-state'
import { useLayoutEffect, useState } from 'react'
import { usePanelVisible } from '@/app/panel-visible'

/** File panels unmount across tasks. Keep their offsets with the device's tabs. */
export function useFileScrollPosition(
  tabId: string,
  view: 'preview' | 'source',
  ready: boolean,
): (node: HTMLElement | null) => void {
  const ui = useUi()
  const visible = usePanelVisible()
  const [node, setNode] = useState<HTMLElement | null>(null)

  useLayoutEffect(() => {
    if (!node || !ready || !visible) return
    const saved = ui.fileScroll.get(`${view}:${tabId}`)
    let pending: FileScrollPosition | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let restoring = saved !== undefined
    const restore = () => {
      if (!saved) return
      node.scrollTop = saved.top
      node.scrollLeft = saved.left
    }
    restore()
    // CodeMirror measures its document on the next frame. Reapply after that
    // measurement, before accepting scroll events as a new reading position.
    const frame = requestAnimationFrame(() => {
      restore()
      restoring = false
    })
    const flush = () => {
      if (pending) ui.setFileScroll(`${view}:${tabId}`, pending)
      pending = undefined
      timer = undefined
    }
    const onScroll = () => {
      if (restoring) return
      pending = { top: Math.max(0, node.scrollTop), left: Math.max(0, node.scrollLeft) }
      if (timer === undefined) timer = setTimeout(flush, 150)
    }
    node.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      node.removeEventListener('scroll', onScroll)
      clearTimeout(timer)
      // Use the last scroll event, since hiding/removing a panel can reset its DOM.
      flush()
    }
  }, [node, ready, visible, ui, tabId, view])

  return setNode
}
