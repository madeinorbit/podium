import ts from 'typescript'

/** JSON assets have no declaration output and set emitSkipped without diagnostics. */
export function emitCodeDeclarations(program: ts.Program): void {
  for (const source of program.getSourceFiles()) {
    if (
      source.isDeclarationFile ||
      ts.isJsonSourceFile(source) ||
      program.isSourceFileFromExternalLibrary(source)
    )
      continue
    const emitted = program.emit(source)
    if (emitted.emitSkipped) {
      const detail = emitted.diagnostics
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
        .join('; ')
      throw new Error(
        `API declaration emission failed for ${source.fileName}${detail ? `: ${detail}` : ''}`,
      )
    }
  }
}
