/** Endpoints and error policy supplied by the authenticated platform. */
export interface ServerConfig {
  httpOrigin: string
  wsClientUrl: string
}

export function defaultFormatError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return fallback
}
