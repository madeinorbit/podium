import { type IssueDeck, type IssueDeckNode, SESSION_WORD_LABEL, TASK_WORD_LABEL } from '@podium/model'

/** Render the server's snapshot; state and counting stay in the shared model. */
export function renderIssueDeck(deck: IssueDeck): string {
  const { counts } = deck
  const out = [
    `${deck.root.displayRef} ${deck.root.title} — ${TASK_WORD_LABEL[deck.root.word]}`,
    `${counts.done}/${counts.total} tasks done · ${counts.error} Error · ${counts['needs-you']} Needs you · ${counts.working} Working · ${counts.idle} Idle · ${counts.blocked} Blocked · ${counts['not-started']} Not started`,
  ]
  const details = (node: IssueDeckNode, pad: string): void => {
    for (const session of node.sessions) {
      const setup = [session.agentKind, session.model, session.effort].filter(Boolean).join(' ')
      out.push(`${pad}${session.displayRef ?? session.sessionId} [${session.seat}] ${SESSION_WORD_LABEL[session.word]} · ${setup}${session.label ? ` · ${session.label}` : ''}`)
    }
    for (const blocker of node.blockers) {
      out.push(`${pad}waits on ${blocker.displayRef} ${blocker.title}${blocker.external ? ' (outside deck)' : ''}`)
    }
  }
  const walk = (node: IssueDeckNode, depth: number): void => {
    if (node.hidden) return
    const pad = '  '.repeat(depth)
    const counter = node.counter.total ? ` · ${node.counter.done}/${node.counter.total}` : ''
    out.push(`${pad}${node.type === 'phase' ? 'Phase: ' : ''}${node.displayRef} ${node.title} — ${TASK_WORD_LABEL[node.word]}${node.type === 'decision' ? ' [decision]' : ''}${counter}`)
    details(node, `${pad}  `)
    for (const child of node.children) walk(child, depth + 1)
  }
  details(deck.root, '  ')
  for (const child of deck.root.children) walk(child, 1)
  if (deck.proposals.length) {
    out.push('', `Proposed (${deck.proposals.length})`)
    for (const proposal of deck.proposals) {
      const author = proposal.proposedBy
      out.push(`  ${proposal.displayRef} ${proposal.title} — ${TASK_WORD_LABEL[proposal.word]} · ${proposal.placement === 'here' ? 'here' : 'own issue'}${author ? ` · proposed by ${author.displayRef ?? author.sessionId}` : ''}`)
      details(proposal, '    ')
      for (const child of proposal.children) walk(child, 2)
    }
  }
  return out.join('\n')
}
