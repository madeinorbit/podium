import { describe, expect, it } from 'vitest'
import { readSharedIssuesDisplay, writeSharedIssuesDisplay } from './issues-display-preference'

describe('shared issues display preference', () => {
  it('updates shared fields without erasing platform-owned fields', () => {
    const mobile = readSharedIssuesDisplay(
      JSON.stringify({
        layout: 'list',
        ordering: 'created',
        flatten: true,
        showAgentTasks: false,
        badges: { labels: false, sessions: true },
      }),
    )
    const persisted = writeSharedIssuesDisplay({
      ...mobile,
      ordering: 'updated',
      showAgentTasks: true,
    })

    expect(JSON.parse(persisted)).toEqual({
      layout: 'list',
      ordering: 'updated',
      flatten: true,
      showAgentTasks: true,
      badges: { labels: false, sessions: true },
    })
  })
})
