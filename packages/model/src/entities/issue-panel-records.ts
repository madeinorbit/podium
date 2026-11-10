import { z } from 'zod'
import { IssueIdField } from '../ids'
import {
  IssuePanelArtifact,
  IssuePanelDeferred,
  IssuePanelItemIdentity,
  IssuePanelTodo,
} from './issue-vocabulary'

/** Stable item identity is independent of its human list position. */
const item = IssuePanelItemIdentity.shape
export const IssuePanelTodoWire = IssuePanelTodo.extend(item)
export type IssuePanelTodoWire = z.infer<typeof IssuePanelTodoWire>
export const IssuePanelArtifactWire = IssuePanelArtifact.extend(item)
export type IssuePanelArtifactWire = z.infer<typeof IssuePanelArtifactWire>
export const IssuePanelDeferredWire = IssuePanelDeferred.extend(item)
export type IssuePanelDeferredWire = z.infer<typeof IssuePanelDeferredWire>
/** The state paragraph and assistant digest have one durable home. */
export const IssuePanelStateWire = z.object({
  id: IssueIdField,
  text: z.string(),
  updatedAt: z.string(),
})
export type IssuePanelStateWire = z.infer<typeof IssuePanelStateWire>
export const ISSUE_PANEL_KINDS = [
  'issuePanelTodo',
  'issuePanelArtifact',
  'issuePanelDeferred',
  'issuePanelState',
] as const
export type IssuePanelKind = (typeof ISSUE_PANEL_KINDS)[number]
export const isIssuePanelKind = (kind: string): kind is IssuePanelKind =>
  (ISSUE_PANEL_KINDS as readonly string[]).includes(kind)
