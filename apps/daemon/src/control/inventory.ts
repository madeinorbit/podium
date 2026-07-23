import { buildInventory } from '@podium/agent-bridge'
import type { Inventory } from '@podium/protocol'
import type { ControlHandlers, DaemonContext } from './context'

/**
 * Machine inventory reporting (#222): build os/arch + per-harness
 * install/version/login and push it to the server. Fired unsolicited right
 * after the handshake authenticates (every (re)connect) and on an
 * inventoryRequest frame and periodically while connected. Never throws and
 * never rides the handshake path: a hung CLI probe cannot stall reconnect.
 *
 * The build spawns up to five real CLIs for `--version`, so it runs ONCE and is
 * cached (per homeDir — tests boot daemons against fixture homes); reconnects
 * re-send the cached value. Explicit and periodic refreshes REBUILD so installs,
 * upgrades, and login changes on a live machine converge without a daemon restart.
 */
const inventoryCache = new Map<string, Promise<Inventory>>()

export const DEFAULT_INVENTORY_REFRESH_INTERVAL_MS = 60_000

export async function reportInventory(
  ctx: DaemonContext,
  opts: { rebuild?: boolean } = {},
): Promise<void> {
  const key = ctx.homeDir ?? ''
  let pending: Promise<Inventory> | undefined
  try {
    pending = opts.rebuild ? undefined : inventoryCache.get(key)
    if (!pending) {
      pending = buildInventory(ctx.homeDir ? { homeDir: ctx.homeDir } : {})
      inventoryCache.set(key, pending)
    }
    const inventory = await pending
    // A credential install can force a rebuild while the initial handshake
    // probe is still shelling out to the agent CLIs. The old probe observed the
    // pre-copy auth files and may finish last; never let that superseded result
    // overwrite the newer logged-in inventory on the server.
    if (inventoryCache.get(key) !== pending) return
    ctx.send({ type: 'inventoryReport', machineId: ctx.machineId, inventory })
  } catch (err) {
    // Evict only OUR failed build — a concurrent rebuild may have already stored
    // a fresh pending under this key; don't discard it.
    if (inventoryCache.get(key) === pending) inventoryCache.delete(key)
    console.warn(
      `[podium:daemon] inventory report failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/** Refresh changing agent capabilities while the authenticated daemon remains live. */
export function startInventoryRefresh(
  ctx: DaemonContext,
  intervalMs = DEFAULT_INVENTORY_REFRESH_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => void reportInventory(ctx, { rebuild: true }), intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

export const inventoryHandlers: Pick<ControlHandlers, 'inventoryRequest'> = {
  inventoryRequest: (ctx) => {
    void reportInventory(ctx, { rebuild: true })
  },
}
