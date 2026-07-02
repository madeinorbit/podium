import type { IssueWire } from '@podium/protocol'

export interface IssueDetailFields {
  comments: { author: string; body: string; createdAt: string }[]
}

/**
 * Pure read-only view-model for the parts of an `IssueWire` that `IssuePage`
 * renders beyond its editable properties — currently just the comment thread,
 * normalized to the `{ author, body, createdAt }` shape the UI displays.
 */
export function issueDetailFields(issue: IssueWire): IssueDetailFields {
  return {
    comments: issue.comments.map((c) => ({
      author: c.author,
      body: c.body,
      createdAt: c.createdAt,
    })),
  }
}
