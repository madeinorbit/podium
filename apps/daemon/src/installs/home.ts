import { scanAgentConversations } from '@podium/harness'
import { readManagedInstalls } from '@podium/harness/inventory'
import { type HomeHarness, podiumHomeId } from '@podium/protocol'
import type { HomeRegistry } from '../homes/registry'

type Homes = Pick<HomeRegistry, 'get' | 'remove'>

/** Scan only this Podium home, without the person's default roots. */
export async function inspectPodiumHome(homes: Homes, harness: HomeHarness) {
  const home = homes.get(podiumHomeId(harness))
  if (!home) return { homeExists: false, conversations: [] }
  const scanned = await scanAgentConversations({
    agents: [harness],
    includeDefaults: false,
    extraRoots: { [harness]: [home.dir] },
  })
  if (scanned.diagnostics.some((item) => item.severity === 'error'))
    throw new Error('Podium could not read every conversation in this home. Nothing was deleted.')
  return {
    homeExists: true,
    conversations: scanned.conversations
      .map((conversation) => ({
        id: conversation.id,
        title: conversation.title ?? conversation.id,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  }
}

/** Inspect again at deletion, including after stopping its processes, so new conversations need confirmation. */
export async function removePodiumHome(
  homes: Homes,
  harness: HomeHarness,
  harnessesDir: string,
  confirmed: string[] | undefined,
) {
  if (!confirmed)
    throw new Error(
      'Inspect this home and confirm the conversations stored there before deleting it.',
    )
  if (readManagedInstalls(harnessesDir).harnesses.has(harness))
    throw new Error(
      'Remove Podium’s harness copy and wait for its running sessions to exit before deleting its home.',
    )
  const verify = async () => {
    const actual = (await inspectPodiumHome(homes, harness)).conversations.map(
      (conversation) => conversation.id,
    )
    const expected = [...new Set(confirmed)].sort()
    if (JSON.stringify([...actual].sort()) !== JSON.stringify(expected))
      throw new Error(
        'The conversations in this home changed. Inspect them and confirm again. Nothing was deleted.',
      )
  }
  await verify()
  return await homes.remove(podiumHomeId(harness), {
    podiumHomeConfirmed: true,
    beforeDelete: verify,
  })
}
