import * as store from '@/app/store'

/** Read the explicit snapshot supplied by a provider-free component fixture. */
export function fixtureSnapshot<T>(read: (state: any) => T): T {
  const fixture = Reflect.get(store, 'readFixture')
  if (typeof fixture !== 'function') throw new Error('This test needs a fixture snapshot')
  return fixture(read)
}
