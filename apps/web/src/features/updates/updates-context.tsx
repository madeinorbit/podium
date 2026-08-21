/**
 * THE UPDATE SURFACE'S FRONT DOOR — and deliberately nothing else (POD-2190).
 *
 * The app shell mounts this, so whatever it imports is in the EAGER graph: parsed
 * and executed before the first paint, on every load, forever. What it used to
 * import was the entire update surface — the poller, the 33 KB view model, the
 * protocol's operation parser, the panel renderer — 99 KB of source whose first
 * useful moment is when a poll comes back saying there is something to show. A
 * poll cannot come back before the app has painted. That weight was over the web
 * bundle's eager budget and it was buying nothing.
 *
 * So this file is a LOADER. It mounts `UpdatesEngine` — the whole previous body
 * of this module, unchanged — from a chunk fetched a beat after first paint.
 *
 * WHAT MAKES THIS SAFE, given that the entire point of the surface is that an
 * update is never unreachable (spec §1.1):
 *
 *  - The engine is fetched ON MOUNT, not on demand. It is on its way before the
 *    shell has finished booting, and it is in memory long before an update can be
 *    offered. Deferring to the first CLICK would have meant fetching a hashed
 *    chunk at the moment an update replaces the dist that serves it — a 404
 *    exactly when the update needs a UI.
 *  - `children` are NOT inside the Suspense boundary. They are siblings, so the
 *    app's tree — its store, its replica, its sockets — neither waits for this
 *    chunk nor remounts when it lands.
 *  - Nothing is lost in the window before it lands. The strip reads the store in
 *    `updates-panel-context`, which answers "no update" until the engine
 *    publishes, and until the engine's first poll returns that is not a
 *    placeholder — it is the truth.
 */
import type { JSX, ReactNode } from 'react'
import { lazy, Suspense } from 'react'
import { isIterationMode } from '@/lib/iteration-mode'

const UpdatesEngine = lazy(() =>
  import('./UpdatesEngine').then((module) => ({ default: module.UpdatesEngine })),
)

export interface UpdatesProviderProps {
  httpOrigin?: string
  /** Injected for the test; production reads the build define. */
  iterating?: boolean
  children?: ReactNode
}

/**
 * ITERATION MODE TURNS THE UPDATER OFF AT THE FRONT DOOR (POD-2513, spec §7).
 *
 * A `bun run iterate` page is source served by Vite in front of the INSTALLED
 * server, and the update state it would poll is that server's — real, and
 * nothing to do with the bundle you are looking at. Two things go wrong if the
 * engine mounts anyway. The offer is genuine: pressing it starts a real rollout
 * across the fleet, from a page that is not the installed app and whose own
 * changes are not in the release being rolled out. And the panel opens ITSELF
 * on a new situation, so every branch that touches the wire schema greets you
 * with a modal instead of your UI.
 *
 * Not mounting also means the chunk is never fetched, so the whole surface —
 * poller, view model, panel — is absent rather than merely quiet.
 *
 * `children` render either way: this switches off the updater, not the app.
 */
export function UpdatesProvider({
  httpOrigin,
  iterating = isIterationMode(),
  children,
}: UpdatesProviderProps): JSX.Element {
  if (iterating) return <>{children}</>
  return (
    <>
      {/* `null` is the correct fallback, not a spinner: there is nothing to
          announce yet, and announcing that we are looking would be noise on
          every single load. */}
      <Suspense fallback={null}>
        <UpdatesEngine httpOrigin={httpOrigin} />
      </Suspense>
      {children}
    </>
  )
}
