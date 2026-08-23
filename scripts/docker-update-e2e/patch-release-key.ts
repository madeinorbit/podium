export {}

const path = process.argv[2]
const pubkey = process.env.PODIUM_UPDATE_E2E_RELEASE_PUBKEY
if (!path || !pubkey) throw new Error('path and release public key are required')

const source = await Bun.file(path).text()
const replacement = `export const PODIUM_UPDATE_PUBKEY = '${pubkey}'`
const next = source.replace(
  /export const PODIUM_UPDATE_PUBKEY = '[^']+'/,
  replacement,
)
if (next === source) {
  throw new Error('release trust root declaration was not replaced')
}
if ((next.match(/export const PODIUM_UPDATE_PUBKEY = /g) ?? []).length !== 1) {
  throw new Error('release trust root declaration is not unique')
}
await Bun.write(path, next)
