export interface LocalCredentialSurfaces {
  clearHttpRuntime(): void
  clearWebSocket(): void
  clearBearer(): void
  markCredentialUnreleased(): void
}

/** Local-only invalidation. This boundary deliberately has no network capability. */
export function clearLocalCredentialSurfaces(surfaces: LocalCredentialSurfaces): void {
  surfaces.clearHttpRuntime()
  surfaces.clearWebSocket()
  surfaces.clearBearer()
  surfaces.markCredentialUnreleased()
}

/**
 * Override identity preflight must begin credential-free. A failed result or
 * thrown transport error clears again so no concurrently acquired bearer can
 * survive the failed validation.
 */
export async function preflightNativeOverride<T extends { ok: boolean }>(args: {
  clearLocalCredentials(): void
  preflight(): Promise<T>
}): Promise<T> {
  args.clearLocalCredentials()
  try {
    const result = await args.preflight()
    if (!result.ok) args.clearLocalCredentials()
    return result
  } catch (cause) {
    args.clearLocalCredentials()
    throw cause
  }
}
