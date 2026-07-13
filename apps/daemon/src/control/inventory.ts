import { buildInventory } from '@podium/agent-bridge'
import type { Inventory } from '@podium/protocol'
import type { ControlHandlers, DaemonContext } from './context'

/**
 * Machine inventory reporting (#222): build os/arch + per-harness
 * install/version/login and push it to the server. Fired unsolicited right
 * after the handshake authenticates (every (re)connect) and on an
 * inventoryRequest frame. Never throws and never rides the handshake path: a
 * hung CLI probe cannot stall reconnect.
 *
 * The build spawns up to five real CLIs for `--version`, so it runs ONCE and is
 * cached (per homeDir — tests boot daemons against fixture homes); reconnects
 * re-send the cached value. An explicit inventoryRequest REBUILDS, which is the
 * self-heal path after someone hand-installs a CLI on a live machine.
 */
const inventoryCache = new Map<string, Promise<Inventory>>()

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

export const inventoryHandlers: Pick<ControlHandlers, 'inventoryRequest'> = {
  inventoryRequest: (ctx) => {
    void reportInventory(ctx, { rebuild: true })
  },
}
