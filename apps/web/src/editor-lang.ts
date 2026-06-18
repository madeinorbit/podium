export type LangId = 'javascript' | 'json' | 'markdown' | 'python' | 'css' | 'html' | 'plain'

const BY_EXT: Record<string, LangId> = {
  ts: 'javascript', tsx: 'javascript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json',
  md: 'markdown', markdown: 'markdown',
  py: 'python',
  css: 'css', scss: 'css',
  html: 'html', htm: 'html',
}

export function langIdForPath(path: string): LangId {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return BY_EXT[ext] ?? 'plain'
}

/** Lazily import the CodeMirror language extension for a file. Kept out of the
 *  first-paint bundle. */
export async function loadLanguage(id: LangId): Promise<import('@codemirror/state').Extension[]> {
  switch (id) {
    case 'javascript':
      return [(await import('@codemirror/lang-javascript')).javascript({ jsx: true, typescript: true })]
    case 'json':
      return [(await import('@codemirror/lang-json')).json()]
    case 'markdown':
      return [(await import('@codemirror/lang-markdown')).markdown()]
    case 'python':
      return [(await import('@codemirror/lang-python')).python()]
    case 'css':
      return [(await import('@codemirror/lang-css')).css()]
    case 'html':
      return [(await import('@codemirror/lang-html')).html()]
    default:
      return []
  }
}
