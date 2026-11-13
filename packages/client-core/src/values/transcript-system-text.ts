/** Successful local /compact output repeats the compaction row and hook plumbing.
 * Keep failures and all other command output visible on every client. */
export function transcriptSystemText(text: string): string {
  return text
    .split('\n')
    .filter(
      (line) =>
        !/^\s*Compacted \(ctrl\+o to see full summary\)\s*$/i.test(line) &&
        !/^\s*PreCompact \[[^\r\n]*\] completed successfully\.?\s*$/.test(line),
    )
    .join('\n')
    .trim()
}
