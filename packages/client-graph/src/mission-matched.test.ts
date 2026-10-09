import { autorun } from 'mobx'
import { expect, it } from 'vitest'
import { installMobxWarnTrap } from '../../../tests/worklist/harness/src/mobx-trap'
import { coldMissionRowFixture } from './mission-row-loading.test.fixture'

installMobxWarnTrap({ errors: true })

it('reads full-mode matching without a constant computed or loading the issue', () => {
  const { pool, row, close } = coldMissionRowFixture()
  let matched = false
  const stop = autorun(() => {
    // A strip also reads observable content; full-mode matching is constant.
    void pool.issueObject('root').stage
    matched = row.matched
  })
  try {
    expect(matched).toBe(true)
    expect(pool.hydrate()).toBe(0)
  } finally {
    stop()
    close()
  }
})
