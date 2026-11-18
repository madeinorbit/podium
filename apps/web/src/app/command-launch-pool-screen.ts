import type { ClientRuntime } from '@podium/client-core/runtime-root'
import type { MobxPool } from '@podium/client-graph'

/** The registry owns the existing source attachment and its disposal. */
export const commandLaunchScreen = {
  id: 'commands',
  async attach(runtime: ClientRuntime, pool: MobxPool) {
    const [{ attachCommandLaunchSource }, { launchOptionViews }] = await Promise.all([
      import('@podium/client-graph/command-launch-source'),
      import('@podium/client-graph/launch-option-views'),
    ])
    launchOptionViews(pool)
    const source = attachCommandLaunchSource(pool, runtime)
    return () => source.dispose()
  },
}
