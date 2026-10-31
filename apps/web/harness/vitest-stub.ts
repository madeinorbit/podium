// The test fixtures the deck harness borrows register vitest teardown hooks at
// import. A harness page lives for one session, so there is nothing to tear down.
export const afterEach = (): void => {}
export const afterAll = (): void => {}
