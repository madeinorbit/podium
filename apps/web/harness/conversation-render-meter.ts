/** Build-only instrumentation: count actual component bodies in both revisions. */
import type { Plugin } from 'vite'
import ts from 'typescript'

export function conversationRenderMeter(surface: 'web' | 'phone'): Plugin {
  const names: Record<string, string> = surface === 'web'
    ? { ChatView: 'shell', ConversationChatView: 'shell', TranscriptFeed: 'frame', ChatBlockView: 'row', ChatComposer: 'composer' }
    : { SessionConversation: 'shell', SessionConversationBody: 'shell', TranscriptList: 'frame', TranscriptFeedRow: 'row', Composer: 'composer' }
  const seen = new Set<string>()
  return {
    name: 'conversation-render-meter', enforce: 'pre',
    transform(code, id) {
      if (!id.includes(`/apps/${surface === 'web' ? 'web/src/features/chat' : 'mobile/src/components'}/`) || !id.endsWith('.tsx')) return
      const ast = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
      const inserts: { at: number; counter: string }[] = []
      const visit = (node: import('typescript').Node) => {
        if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name && node.body) {
          const counter = names[node.name.text]
          if (counter) { inserts.push({ at: node.body.getStart(ast) + 1, counter }); seen.add(counter) }
        }
        ts.forEachChild(node, visit)
      }
      visit(ast)
      for (const { at, counter } of inserts.sort((a, b) => b.at - a.at))
        code = `${code.slice(0, at)}\nglobalThis.__chatRenderWork.${counter}++;\n${code.slice(at)}`
      return inserts.length ? { code, map: null } : undefined
    },
    buildEnd(error) {
      if (!error) for (const key of ['frame', 'row', 'composer', 'shell'])
        if (!seen.has(key)) throw new Error(`Missing ${surface} ${key} render boundary`)
    },
  }
}
