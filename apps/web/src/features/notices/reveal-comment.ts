/**
 * Bring one comment into view once the task page has drawn it (POD-6881): a
 * mention notice opens its task at the comment. The page renders after the
 * navigation, so this looks for the card for a short while, then gives up
 * quietly: the task is open either way.
 */

const TRIES = 40

export function revealComment(commentId: string, root: ParentNode = document): void {
  let tries = 0
  const look = (): void => {
    const card = root.querySelector<HTMLElement>(`[data-comment-id="${CSS.escape(commentId)}"]`)
    if (card !== null) {
      card.scrollIntoView({ block: 'center', behavior: 'smooth' })
      card.dataset.revealed = 'true'
      setTimeout(() => {
        delete card.dataset.revealed
      }, 2000)
      return
    }
    tries += 1
    if (tries < TRIES) requestAnimationFrame(look)
  }
  requestAnimationFrame(look)
}
