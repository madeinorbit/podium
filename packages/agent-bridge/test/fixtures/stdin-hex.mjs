// Emits the exact hex of every stdin chunk, framed, so a test can assert byte-fidelity.
// Raw mode is required: without it the PTY line discipline (cooked mode) interprets
// control bytes — e.g. Ctrl-C (0x03) is echoed as "^C" and never reaches stdin as a
// raw byte. Raw mode disables that processing so every byte arrives unmodified, which
// is exactly the input path the daemon uses (xterm.js sends raw bytes). Applied here so
// BOTH the tmux and direct node-pty paths are measured identically.
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.on('data', (d) => process.stdout.write('<' + d.toString('hex') + '>'))
setInterval(() => {}, 1000)
