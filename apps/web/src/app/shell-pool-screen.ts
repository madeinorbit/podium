import type { PoolScreen } from '@podium/client-graph/host'
export const shellPoolScreen: PoolScreen = {
  id: 'shell',
  options: () => ({
    shell: true,
    header: true,
  }),
  async attach(runtime, pool) {
    const [{ ShellSource }, { SHELL_SOURCE_KEY, SHELL_ENTITIES }] = await Promise.all([
      import('@podium/client-graph/shell-source'),
      import('@podium/client-graph/shell-schema'),
    ])
    await pool.sources.ensure(SHELL_SOURCE_KEY, SHELL_ENTITIES, () => new ShellSource(runtime))
  },
}
