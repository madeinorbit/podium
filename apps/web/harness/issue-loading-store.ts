import { readFixture as readDeckFixture } from './deck-store-stub.ts'

/** Request answers belong only to this fixture; every write is a no-op. */
const request = (path: readonly string[] = []): unknown =>
  new Proxy(() => {}, {
    get: (_target, key) => (typeof key === 'string' ? request([...path, key]) : undefined),
    apply: () => {
      const name = path.join('.')
      if (name === 'settings.get.query') return Promise.resolve({ gitWorkflow: {} })
      if (name === 'issues.get.query' || name === 'features.state.query')
        return Promise.resolve(null)
      return Promise.resolve(path.at(-1) === 'query' ? [] : {})
    },
  })
const trpc = request()

export function readFixture<T>(select: (state: Record<string, unknown>) => T): T {
  return readDeckFixture((state) => select({ ...state, trpc }))
}
