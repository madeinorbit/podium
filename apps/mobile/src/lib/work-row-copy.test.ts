import { describe, expect, it } from 'vitest'
import { workLaneTitle, workMenuItem } from './work-row-copy'

describe('workLaneTitle', () => {
  it('shows the count beside the lane name', () =>
    expect(workLaneTitle('open', 18)).toBe('Open 18'))
  it('drops a zero count', () => expect(workLaneTitle('snoozed', 0)).toBe('Snoozed'))
})

describe('workMenuItem', () => {
  const idle = { unread: false, inMission: false }
  it('names the board menu', () => {
    expect(workMenuItem('rename', idle).label).toBe('Rename')
    expect(workMenuItem('read', idle).label).toBe('Mark as Unread')
    expect(workMenuItem('read', { ...idle, unread: true }).label).toBe('Mark as Read')
    expect(workMenuItem('placement', { ...idle, inMission: true }).label).toBe(
      'Move Out of Mission',
    )
    expect(workMenuItem('placement', idle).label).toBe('Move into Parent Task')
    expect(workMenuItem('delete', idle)).toEqual({ label: 'Delete…', symbol: 'trash' })
  })
})
