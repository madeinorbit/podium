/**
 * ATTACHING A FAKE DAEMON THE WAY A REAL ONE ARRIVES (POD-3374).
 *
 * `attachDaemon` marks the machine's inventory PENDING (`modules/machines/service.ts`):
 * a persisted inventory describes the PREVIOUS connection, so until the daemon that
 * just attached reports, `listMachines` omits the field and every spawn on that
 * machine is refused with `inventory-unavailable` — "machine 'X' is still probing
 * whether <agent> is installed".
 *
 * A real daemon closes that window itself: it pushes an `inventoryReport` right
 * after the handshake, and the spawn path waits for it (`waitForInventory`). A
 * fixture that writes `store.machines.setMachineInventory` and then attaches never
 * closes it, so the machine sits "still probing" for the rest of the test and the
 * guard refuses — correctly. The fixture is the thing that is wrong, and this is
 * the report it was missing.
 *
 * WHY THE PORT AND NOT `routeDaemonFrame`. The frame would be the more literal
 * spelling, but routing is deliberately fire-and-forget ("a frame is delivered,
 * not answered" — `gateway/daemon-mux.ts`), so a fixture cannot await the
 * recording it triggers, and the only public way to wait for it,
 * `waitForInventory`, sends an `inventoryRequest` control frame into the very
 * message list these tests assert on. So this calls the port that
 * `inventoryReport` dispatches to — `DISPATCH.inventoryReport` in
 * `gateway/daemon-mux.ts` is `ports.machines.recordInventory(principal.machine,
 * msg.inventory)`, this line and nothing else — and awaits it. Same effect, no
 * injected frame, no scheduling race.
 */

import { asMachineId, HarnessAgent, type Inventory, type MachineId } from '@podium/model'
import type { DaemonControlPeer } from '../gateway/daemon-ports'
import type { SessionRegistry } from '../relay'

/**
 * What a fully provisioned machine reports: every harness kind installed and
 * logged in. Fixtures that care about a specific agent's absence must say so by
 * passing their own inventory — this default deliberately refuses nothing, so a
 * test that fails does so on its own subject.
 */
export function fixtureInventory(over: Partial<Inventory> = {}): Inventory {
  return {
    os: 'linux',
    arch: 'x64',
    agents: HarnessAgent.options.map((kind) => ({
      kind,
      installed: true,
      login: { state: 'in' as const },
    })),
    tools: [],
    ...over,
  }
}

/** Attach a fake daemon AND file the inventory report a real one would send. */
export async function attachDaemonWithInventory(
  registry: SessionRegistry,
  machineId: MachineId | string,
  transport: DaemonControlPeer = () => {},
  inventory: Inventory = fixtureInventory(),
): Promise<void> {
  await registry.gateway.attachDaemon(machineId, transport)
  await registry.modules.machines.recordInventory(asMachineId(machineId), inventory)
}
