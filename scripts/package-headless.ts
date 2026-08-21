/**
 * The only one-platform headless packaging entry point.
 *
 * It fresh-builds both clients, captures their identity in a module-branded session,
 * then compiles and packages without crossing a process boundary. Direct build-bun
 * invocation refuses, so packaging cannot silently fall back to whatever dist existed.
 */
import { beginFreshClientPackagingSession, packageHeadlessForFreshClients } from './build-bun'

function main(): void {
  const argv = process.argv.slice(2)
  const session = beginFreshClientPackagingSession(argv, process.env)
  packageHeadlessForFreshClients(session, argv, process.env)
}

if (import.meta.main) main()
