import { describe, expect, it } from 'vitest'
import { quietProjectsLabel, workLaneTitle, workMenuItem, workSubtitle } from './work-row-copy'

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

describe('workSubtitle', () => {
  it('joins the two counts', () => expect(workSubtitle(3, 6)).toBe('3 need you · 6 working'))
  it('drops a zero part', () => {
    expect(workSubtitle(0, 6)).toBe('6 working')
    expect(workSubtitle(2, 0)).toBe('2 need you')
  })
  it('is no subtitle when both are zero', () => expect(workSubtitle(0, 0)).toBeUndefined())
})

describe('quietProjectsLabel', () => {
  it('counts projects', () => {
    expect(quietProjectsLabel(4)).toBe('4 projects with nothing open')
    expect(quietProjectsLabel(1)).toBe('1 project with nothing open')
  })
})
