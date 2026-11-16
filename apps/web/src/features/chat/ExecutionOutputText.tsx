// biome-ignore-all lint/a11y/noNoninteractiveTabindex: independent scroll regions need focus for arrow and page scrolling.
/** The surrounding Output section names this scrollable, retained text. */
export function ExecutionOutputText({ text, id }: { text: string; id: string }) {
  return (
    <pre id={id} className="execution-output-text tool-result-full" tabIndex={0}>
      {text}
    </pre>
  )
}
