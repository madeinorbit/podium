/**
 * ISSUE READ PROJECTIONS (ADR 4 R4) that more than one workspace must name —
 * POD-1141, following the home POD-366 established for the session side in
 * `./session-read.ts`.
 *
 * These are the shapes `packages/issue-client` used to HAND-COPY, because it
 * cannot import `apps/server`. Inventory §3 counts the copies: #7 `TreeNode` is a
 * drifted duplicate of #6 `IssueTreeNode` (it dropped `id` and `type` and let
 * `sessions` go optional), and #8 `ShowWire` is a 22-key hand restatement of the
 * issue wire. Defining them once here is what deletes the drift; the CLI keeps
 * only its documented VERSION-SKEW tolerance, spelled as tolerance rather than as
 * a second contract.
 *
 * ---------------------------------------------------------------------------
 * THE EMBEDS STAY, AND THAT IS A DECISION, NOT AN OVERSIGHT
 * ---------------------------------------------------------------------------
 *
 * `IssueTreeNode.sessions` is a nested entity array of exactly the kind ADR 4
 * D7.1 normalizes away, and POD-367 recorded three nesting deferrals against it
 * with one reason. Re-recorded here because this is now the definition site:
 *
 *   DE-NESTING IT HAS NO RECEIVER. The CLI gets ONE tree payload over ONE round
 *   trip and holds no session collection to join against. Replacing `sessions`
 *   with `sessionIds` would render bare ids where the CLI prints labels and
 *   phases today — a visible regression dressed as normalization. The de-nesting
 *   belongs with the replica-side slice that can serve the join (POD-308), and
 *   is NOT this file's to make.
 *
 * So the embed is relocated exactly as it was. Nothing here spreads it, reaches
 * into it, or derives from it, so no call site has to change when it goes.
 */

import type { IssueTreeSession } from './session-read'

/**
 * One node of an epic subtree payload (issue #82).
 *
 * Generic in its SESSION element so a tolerant reader can supply its own
 * version-skew variant without restating the thirteen scalar keys — which is
 * exactly what inventory #7 did. The server uses the default.
 */
export interface IssueTreeNode<S = IssueTreeSession> {
  id: string
  seq: number
  title: string
  stage: string
  priority: number
  type: string
  assignee?: string
  branch?: string
  needsHuman: boolean
  humanQuestion?: string
  /** Seqs of `blocks` targets this issue waits on (open or closed). */
  blocksDeps: number[]
  /** First 300 chars of the description, whitespace collapsed to one line. */
  description: string
  closed: boolean
  blocked: boolean
  ready: boolean
  /** Sessions currently on this issue (siblings), compact [spec:SP-99d3].
   *  THE EMBED — see this file's header for why it is still here. */
  sessions: S[]
  children: IssueTreeNode<S>[]
  /** Direct children omitted here by the depth/node cap ('(+N more)' in the CLI). */
  omittedChildren: number
}

export interface IssueTree<S = IssueTreeSession> {
  root: IssueTreeNode<S>
  totalNodes: number
  /** Total children omitted across the tree by the depth/node cap. */
  omitted: number
  /** The caps actually applied to this walk, so a caller rendering a truncation
   *  notice can name them without duplicating the server's defaults (POD-1342). */
  maxDepth: number
  maxNodes: number
}

/**
 * The issue as the `show` renderer reads it — inventory §3 #8.
 *
 * A TOLERANT READ, not a `Pick` of `IssueWire`, and the difference is the point.
 * This client also talks to a REMOTE relay, so it can meet a server that sends
 * `null` where the current one omits the key; every optional member is therefore
 * `| null` as well. A straight `Pick<IssueWire, …>` would declare a contract this
 * client cannot actually rely on, and tightening the read here would be a
 * behaviour change dressed as a refactor.
 *
 * What it is NOT is a restatement: the key SET is the projection, spelled once.
 *
 * Generic in its session element for the same reason {@link IssueTreeNode} is.
 */
export interface IssueShowWire<S = IssueTreeSession> {
  id: string
  seq: number
  title: string
  description: string
  brief?: string | null
  stage: string
  priority: number
  ready: boolean
  blocked: boolean
  assignee?: string | null
  needsHuman?: boolean
  humanQuestion?: string | null
  labels?: string[]
  worktreePath?: string | null
  branch?: string | null
  defaultAgent?: string | null
  defaultModel?: string | null
  defaultEffort?: string | null
  machineId?: string | null
  color?: string | null
  /** Designated coordinator session id (bare). */
  coordinatorSessionId?: string | null
  /** Member sessions currently on this issue [spec:SP-99d3]. */
  sessions?: S[]
}
