import { expect, it } from 'vitest'
import { compactAge, taskRowFigure, tasksSubtitle } from './TasksSurface.types'

const counts = { in_progress: 5, review: 11, planning: 0, backlog: 0, proposed: 0, done: 0 }

it('names the project scope and the In Progress and Review counts', () => {
  expect(tasksSubtitle(undefined, counts)).toEqual({
    project: 'All projects',
    counts: '5 in progress · 11 in review',
  })
  expect(tasksSubtitle(['/src/podium'], counts).project).toBe('podium')
  expect(tasksSubtitle(['/a', '/b'], null)).toEqual({ project: '2 projects', counts: '' })
})

it('shows child progress for a parent and a compact age otherwise', () => {
  expect(taskRowFigure({ childCount: 25, childDoneCount: 21 }, '3d ago')).toBe('21/25')
  expect(taskRowFigure({ childCount: 0, childDoneCount: 0 }, '6m ago')).toBe('6m')
  expect(compactAge('just now')).toBe('now')
})
