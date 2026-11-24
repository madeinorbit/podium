/** The mounted runtime owns drafts and durable queue commits, even during an update. */
export const RELOAD_SAVE_BUDGET_MS = 2_000
let prepare: (() => Promise<void>) | undefined
let pending: Promise<void> | undefined
const guards = new Set<() => string | undefined>()

/** In-memory editors must be saved or discarded explicitly before navigation. */
export function registerReloadGuard(check: () => string | undefined): () => void {
  guards.add(check)
  return () => {
    guards.delete(check)
  }
}

function checkReloadGuards(): void {
  for (const check of guards) {
    const reason = check()
    if (reason) throw new Error(reason)
  }
}

/** A signed-in runtime is mounted: there is an open screen and text it owns. */
export function hasReloadPreparation(): boolean {
  return prepare !== undefined
}

export function registerReloadPreparation(callback: () => Promise<void>): () => void {
  prepare = callback
  pending = undefined
  return () => {
    if (prepare === callback) prepare = undefined
  }
}

/**
 * How long a started navigation holds the reload latch. A document still alive
 * after this did not reload: the navigation was lost or is stuck (POD-7154).
 */
export const RELOAD_COMMIT_GRACE_MS = 10_000

/** Coalesce the panel and Workbox's controllerchange navigation into one reload.
 * A failed local save ends visibly and permits a retry, keeping the document alive.
 *
 * A NAVIGATION THAT NEVER COMMITS RELEASES THE LATCH (POD-7154). Starting a
 * navigation does not end the document; the browser can lose the request, and the
 * page then stays as it was. The latch used to stay held for the life of the page,
 * so every later Reload, and the panel's Reset, returned this settled promise and
 * did nothing. It now coalesces only for {@link RELOAD_COMMIT_GRACE_MS}. */
export function withReloadPreparation(navigate: () => void | Promise<void>): Promise<void> {
  if (pending) return pending
  const owner = prepare
  // The callback runs after the latch is assigned, including synchronous refusals.
  const work: Promise<void> = Promise.resolve().then(async () => {
    try {
      await prepareForReload()
      if (prepare !== owner) throw new Error('The draft owner changed; please retry reloading.')
      await navigate()
    } catch (error) {
      if (pending === work) pending = undefined
      throw error
    }
    setTimeout(() => {
      if (pending === work) pending = undefined
    }, RELOAD_COMMIT_GRACE_MS)
  })
  pending = work
  return work
}

export async function prepareForReload(): Promise<void> {
  checkReloadGuards()
  const owner = prepare
  if (!owner) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      owner(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error('Your changes are still being saved. Reload paused; please try again.'),
            ),
          RELOAD_SAVE_BUDGET_MS,
        )
      }),
    ])
    if (prepare !== owner) throw new Error('The draft owner changed; please retry reloading.')
    checkReloadGuards()
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
