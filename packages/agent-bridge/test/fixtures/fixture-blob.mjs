// Emits a large, byte-exact blob bracketed by newline-free ASCII markers, so a test
// can prove the backend delivers every byte without loss/reorder. The template omits
// 0x0a/0x0d so PTY output post-processing (ONLCR) cannot alter it; markers contain no
// newline for the same reason.
const tmpl = []
for (let b = 0; b < 256; b++) if (b !== 0x0a && b !== 0x0d) tmpl.push(b)
const TEMPLATE = Buffer.from(tmpl) // 254 bytes
const REPEAT = 600 // ~152 KB
const blob = Buffer.concat(Array.from({ length: REPEAT }, () => TEMPLATE))
process.stdout.write('BLOB-START|')
process.stdout.write(blob, () => {
  process.stdout.write('|BLOB-END')
})
setInterval(() => {}, 1000)
