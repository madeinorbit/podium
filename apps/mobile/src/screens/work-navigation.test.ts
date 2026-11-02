import { PhoneWorkFilters } from '@podium/client-graph/worklist/phone'
import { expect, it } from 'vitest'
import { readWorkNavigation, workFilterParams } from './work-navigation'
import { restoreWorkFocus } from './work-restoration.web'

it('restores filters from the Work route after the entire screen is remounted', () => {
  let params = {}
  const live = new PhoneWorkFilters(readWorkNavigation(params), (snapshot) => {
    params = workFilterParams(snapshot)
  })
  live.setLane('snoozed')
  live.setQuery('header')
  const remounted = new PhoneWorkFilters(readWorkNavigation(params))
  expect(remounted.lane).toBe('snoozed')
  expect(remounted.query).toBe('header')
  expect(workFilterParams(live)).toMatchObject({ workOffset: undefined, workFocus: undefined })
})
it('normalizes incoming route state without accepting invalid offsets or lanes', () => {
  expect(readWorkNavigation({ workLane: 'unknown', workOffset: '-42' })).toMatchObject({
    lane: 'open',
    query: '',
    offset: 0,
  })
  expect(
    readWorkNavigation({ workLane: ['closed'], workQuery: ['label'], workOffset: 'Infinity' }),
  ).toMatchObject({ lane: 'closed', query: 'label', offset: 0 })
})

it('focuses the current screen while the stack retains an older instance of the same task', () => {
  const previous = document.createElement('button')
  previous.id = 'previous-screen--task'
  previous.hidden = true
  const current = document.createElement('button')
  current.id = 'current-screen--task'
  document.body.append(previous, current)
  try {
    expect(restoreWorkFocus('current-screen--task')).toBe(true)
    expect(document.activeElement).toBe(current)
    expect(restoreWorkFocus('not-mounted-yet')).toBe(false)
  } finally {
    previous.remove()
    current.remove()
  }
})
