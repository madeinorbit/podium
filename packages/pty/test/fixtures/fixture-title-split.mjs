// Emits an OSC-2 title containing multi-byte glyphs, split across two stdout writes so
// the second completes a multi-byte char. A naive per-chunk UTF-8 decode corrupts the
// title; the shared StringDecoder in wrapPty must reassemble it intact.
const title = '🤖 Robot Agent ✓'
const seq = Buffer.from(`\x1b]2;${title}\x07`, 'utf8')
const cut = 6 // splits inside the 🤖 (its bytes are f0 9f a4 96 at offset 4..7)
process.stdout.write('READY|')
process.stdout.write(seq.subarray(0, cut))
setTimeout(() => {
  process.stdout.write(seq.subarray(cut))
}, 60)
setInterval(() => {}, 1000)
