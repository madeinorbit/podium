import type { ClientRuntime } from '@podium/client-core/engine'
import type { MobxPool } from '@podium/client-graph'
import { COMMAND_SUMMARIES } from '@podium/client-graph/command-launch-schema'

/** The registry owns the existing source attachment and its disposal. */
export const commandLaunchScreen = {
  id: 'commands',
  initialize() {},
  enabled: () => true,
  options: () => ({ summaries: COMMAND_SUMMARIES }),
  async attach(runtime: ClientRuntime, pool: MobxPool) {
    const { attachCommandLaunchSource } = await import('@podium/client-graph/command-launch-source')
    const source = attachCommandLaunchSource(pool, runtime)
    return () => source.dispose()
  },
}
