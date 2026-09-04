import type { ChatRow } from '@podium/client-core/viewmodels'
import type { SessionId } from '@podium/model/browser'
import type { Dispatch, SetStateAction } from 'react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { ChatBlock } from './chat'
import { RENDER_WINDOW } from './useTranscriptWindow'

export interface TranscriptReveal {
  nonce: number
  sessionId: SessionId
  itemKey: string
}

export function transcriptRevealRow(
  blocks: readonly ChatBlock[],
  rows: readonly ChatRow[],
  key: string,
): number | undefined {
  const blockIndex = blocks.findIndex((block) => (block.item.cursor ?? block.item.id) === key)
  if (blockIndex < 0) return undefined
  const rowIndex = rows.findIndex((row) =>
    row.kind === 'tools' ? row.blockIndices.includes(blockIndex) : row.blockIndex === blockIndex,
  )
  return rowIndex < 0 ? undefined : rowIndex
}

export function useTranscriptReveal({
  active,
  sessionId,
  request,
  blocks,
  rows,
  initialLoaded,
  computeReady,
  loadingOlder,
  moreAbove,
  renderStart,
  setRenderCount,
  loadOlder,
  scrollToBlock,
  clear,
}: {
  active: boolean
  sessionId: SessionId
  request: TranscriptReveal | null
  blocks: readonly ChatBlock[]
  rows: readonly ChatRow[]
  initialLoaded: boolean
  computeReady: boolean
  loadingOlder: boolean
  moreAbove: boolean
  renderStart: number
  setRenderCount: Dispatch<SetStateAction<number>>
  loadOlder: () => void
  scrollToBlock: (index: number, opts?: { instant?: boolean }) => void
  clear: (nonce: number) => void
}): number | undefined {
  const [revealedRow, setRevealedRow] = useState<number | undefined>()
  const timerRef = useRef<number | undefined>(undefined)
  const pagingAttemptRef = useRef<string | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
    }
  }, [])

  useEffect(() => {
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
    timerRef.current = undefined
    pagingAttemptRef.current = null
    setRevealedRow(undefined)
  }, [sessionId])

  const requestNonce = request?.nonce
  useEffect(() => {
    // Clearing a consumed request is an acknowledgement, not a new reveal.
    // Keep the highlight alive for its timer after the store drops the nonce.
    if (requestNonce === undefined) return
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
    timerRef.current = undefined
    pagingAttemptRef.current = null
    setRevealedRow(undefined)
  }, [requestNonce])

  useEffect(() => {
    if (!active || request?.sessionId !== sessionId) return
    const rowIndex = transcriptRevealRow(blocks, rows, request.itemKey)
    if (rowIndex === undefined) {
      if (!initialLoaded || !computeReady || loadingOlder) return
      if (moreAbove) {
        const oldest = blocks[0]?.item
        const attempt = `${request.nonce}\n${oldest?.cursor ?? oldest?.id ?? ''}\n${blocks.length}\n${renderStart}`
        if (pagingAttemptRef.current === attempt) {
          clear(request.nonce)
          toast.info('That transcript position is no longer available.')
          return
        }
        pagingAttemptRef.current = attempt
        loadOlder()
        return
      }
      clear(request.nonce)
      toast.info('That transcript position is no longer available.')
      return
    }

    if (rowIndex < renderStart) {
      setRenderCount(rows.length - rowIndex + RENDER_WINDOW)
      return
    }

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    pagingAttemptRef.current = null
    setRevealedRow(rowIndex)
    requestAnimationFrame(() => scrollToBlock(rowIndex, { instant: reducedMotion }))
    clear(request.nonce)
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setRevealedRow(undefined), 1_800)
  }, [
    active,
    blocks,
    clear,
    computeReady,
    initialLoaded,
    loadOlder,
    loadingOlder,
    moreAbove,
    renderStart,
    request,
    rows,
    scrollToBlock,
    sessionId,
    setRenderCount,
  ])

  return revealedRow
}
