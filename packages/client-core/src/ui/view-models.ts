import type { SessionId } from '@podium/model'
import { action, actionBound, observable, observableRef } from 'mobx'
import type { TranscriptRevealRequest } from '../engine/types'

/** Always-on palette view model; opening a palette is never saved navigation. */
export class PaletteViewModel {
  @observable accessor open = false
  @actionBound setOpen(open: boolean): void {
    this.open = open
  }
}
/** The auto-continue dialog owns the session it is asking about. */
export class AutoContinueDialogModel {
  @observable accessor sessionId: SessionId | null = null
  @actionBound open(sessionId: SessionId): void {
    this.sessionId = sessionId
  }
  @actionBound close(): void {
    this.sessionId = null
  }
}
/** Navigation delivers a reveal action to the chat view, including its first mount. */
export class TranscriptRevealActions {
  private nonce = 0
  private pending: TranscriptRevealRequest | null = null
  private readonly listeners = new Set<(request: TranscriptRevealRequest) => void>()
  reveal(sessionId: SessionId, itemKey: string): void {
    const request = { sessionId, itemKey, nonce: ++this.nonce }
    this.pending = request
    for (const listener of this.listeners) listener(request)
  }
  listen(sessionId: SessionId, reveal: (request: TranscriptRevealRequest) => void): () => void {
    const listener = (request: TranscriptRevealRequest) => {
      if (request.sessionId !== sessionId) return
      this.pending = null
      reveal(request)
    }
    this.listeners.add(listener)
    if (this.pending) listener(this.pending)
    return () => this.listeners.delete(listener)
  }
  dispose(): void {
    this.pending = null
    this.listeners.clear()
  }
}
