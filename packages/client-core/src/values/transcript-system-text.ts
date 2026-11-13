/** Successful local /compact output repeats the compaction row and hook plumbing.
 * Keep failures and all other command output visible on every client. */
export function transcriptSystemText(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      if (/^\s*Compacted \(ctrl\+o to see full summary\)\s*$/i.test(line)) return false
      // Claude appends the hook's stdout, including the usual empty JSON, to
      // both compaction hook events. Commands can contain nested shell brackets.
      const success =
        /^\s*(?:PreCompact|PostCompact) \[[^\r\n]*\] completed successfully(?:\.|:\s*(.*))?\s*$/.exec(
          line,
        )
      return !success || /\b(?:error|failed|failure)\b/i.test(success[1] ?? '')
    })
    .join('\n')
    .trim()
}
