/**
 * The three panel views POD-2179 is about, computed by the REAL view function.
 *
 * Run it on this branch and again with the worktree detached at the fork point
 * (the script is untracked there and survives the checkout), and the two JSON
 * files are the before/after evidence behind panel-before-after.html:
 *
 *   bun --conditions=@podium/source .artifacts/POD-2179/capture-panel.ts > after.json
 *   git checkout --detach worktree-updater-spec
 *   bun --conditions=@podium/source .artifacts/POD-2179/capture-panel.ts > before.json
 *   git checkout issue/2179-panel-place-and-surface-repair
 *
 * The condition is what makes the workspace packages resolve to their SOURCE:
 * `@podium/protocol` publishes `./dist`, and nothing has built it here.
 *
 * No server and no browser: `operationView` is a pure function of the operation
 * the server serves plus this surface's one local fact, which is exactly why
 * the panel can be evidenced without a build (spec §6).
 */
import { parseOperation } from '@podium/protocol'
import { operationView } from '../../apps/web/src/features/updates/operation-view'

const NOW = 1_765_700_100_000

const scenarios = [
  {
    id: 'moving-place',
    title: 'A fleet update: alpha has converged, beta is still downloading',
    what: 'The step line should name the machine the user is waiting for.',
    payload: {
      id: 'op_01j',
      kind: 'update',
      details: { target: { version: '0.4.4', channel: 'dev' } },
      state: 'running',
      startedAt: NOW - 30_000,
      updatedAt: NOW - 1_000,
      steps: [
        {
          id: 'machines',
          title: 'Updating your machines',
          state: 'running',
          startedAt: NOW - 30_000,
          lastProgressAt: NOW - 1_000,
          progress: { done: 1, total: 2 },
          places: [
            { id: 'm_a', name: 'alpha', state: 'current', percent: 100 },
            { id: 'm_b', name: 'beta', state: 'downloading', percent: 62 },
          ],
        },
      ],
    },
    surface: 'web' as const,
    local: { behind: false, canReload: true, canInstallDesktop: false },
  },
  {
    id: 'stuck-place',
    title: 'The same update after beta reported a dirty checkout',
    what: 'Nothing is moving, so the machine that said why is the news.',
    payload: {
      id: 'op_01j',
      kind: 'update',
      details: { target: { version: '0.4.4', channel: 'dev' } },
      state: 'running',
      startedAt: NOW - 300_000,
      updatedAt: NOW - 300_000,
      steps: [
        {
          id: 'machines',
          title: 'Updating your machines',
          state: 'stalled',
          startedAt: NOW - 300_000,
          lastProgressAt: NOW - 300_000,
          progress: { done: 1, total: 3 },
          places: [
            { id: 'm_a', name: 'alpha', state: 'current', percent: 100 },
            { id: 'm_b', name: 'beta', state: 'stuck', detail: 'The checkout has local changes.' },
            { id: 'm_c', name: 'macbook', state: 'pending' },
          ],
        },
      ],
    },
    surface: 'web' as const,
    local: { behind: false, canReload: true, canInstallDesktop: false },
  },
  {
    id: 'all-in-one-browser',
    title: 'A browser tab watching an all-in-one update',
    what: 'The only outstanding work is a desktop install on that machine.',
    payload: {
      id: 'op_01k',
      kind: 'update',
      details: { target: { version: '0.4.4', channel: 'dev' } },
      state: 'waiting',
      startedAt: NOW - 20_000,
      updatedAt: NOW - 20_000,
      steps: [],
      awaiting: [
        {
          id: 'desktop-install',
          surface: 'desktop-all-in-one',
          title: 'Install the update in Podium Desktop',
          detail: 'Finish this in Podium Desktop on ludovico.',
          place: 'm_host',
          required: true,
        },
      ],
    },
    surface: 'web' as const,
    // Behind by construction: the server cannot have been replaced until the
    // shell installs.
    local: { behind: true, canReload: true, canInstallDesktop: false },
  },
]

const captured = scenarios.map((scenario) => ({
  id: scenario.id,
  title: scenario.title,
  what: scenario.what,
  view: operationView({
    operation: parseOperation(scenario.payload),
    offer: null,
    local: scenario.local,
    surface: scenario.surface,
    now: NOW,
  }),
}))

console.log(JSON.stringify(captured, null, 2))
