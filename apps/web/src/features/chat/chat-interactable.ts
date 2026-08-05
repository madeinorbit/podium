/**
 * The DOM-side contract for `chat:interactable`.
 *
 * A transcript paint alone is not enough: the composer must be a live,
 * focusable control, and the transcript must either have committed its settled
 * state or already have scrollable content.
 */
export function isChatComposerFocusable(textarea: HTMLTextAreaElement | null): boolean {
  if (!textarea || textarea.disabled || textarea.tabIndex < 0 || !textarea.isConnected) return false
  if (typeof getComputedStyle === 'function') {
    const style = getComputedStyle(textarea)
    if (style.display === 'none' || style.visibility === 'hidden') return false
  }
  return textarea.getClientRects().length > 0
}

export function isChatInteractable(input: {
  textarea: HTMLTextAreaElement | null
  transcript: HTMLElement | null
  /** True once the initial transcript read has resolved, including empty. */
  transcriptCommitted: boolean
}): boolean {
  if (!isChatComposerFocusable(input.textarea)) return false
  if (input.transcriptCommitted) return true
  const transcript = input.transcript
  return transcript !== null && transcript.scrollHeight > transcript.clientHeight
}
