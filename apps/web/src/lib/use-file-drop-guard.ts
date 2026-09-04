import { useEffect } from 'react'

/**
 * A MISSED FILE DROP MUST NOT TAKE THE APP WITH IT (POD-1595).
 *
 * A browser's default action for a file released on a page is to NAVIGATE to
 * that file. In a document that is fine. In this one the page is the whole
 * workspace — panels, a half-written prompt, scroll positions in three
 * transcripts — and a drop that lands two centimetres wide of the conversation
 * replaces all of it with a PDF viewer. The operator's mistake was missing a
 * target by a little; the punishment was losing everything they had open.
 *
 * So: nothing outside a real drop zone is a drop. The guard runs LAST, after
 * bubbling has given every zone its chance, and claims only what no zone did —
 * `defaultPrevented` is that signal, because accepting a drop is exactly what
 * calling `preventDefault` on `dragover` means. Over unclaimed ground it says
 * `dropEffect = 'none'`, so the cursor keeps telling the truth ("not here")
 * rather than promising a drop that would do nothing; the zones that DID claim
 * the drag are never touched, and keep their own cursor.
 *
 * Non-file drags are ignored outright. Nothing in this app drags with the HTML5
 * API today — the work lists are pointer-based — but a guard that swallowed
 * every drag would be lying in wait for the first thing that does.
 */
export function useFileDropGuard(): void {
  useEffect(() => {
    const carriesFiles = (event: DragEvent): boolean => {
      const items = event.dataTransfer?.items
      if (!items) return false
      for (let i = 0; i < items.length; i++) {
        if (items[i]?.kind === 'file') return true
      }
      return false
    }
    const swallow = (event: DragEvent): void => {
      // A drop zone already accepted this drag — leave it entirely alone.
      if (event.defaultPrevented) return
      if (!carriesFiles(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'
    }
    window.addEventListener('dragover', swallow)
    window.addEventListener('drop', swallow)
    return () => {
      window.removeEventListener('dragover', swallow)
      window.removeEventListener('drop', swallow)
    }
  }, [])
}
