// Integration fixture: marker, OSC title, hex-echo of stdin, stays alive.
process.stdout.write('READY\n')
process.stdout.write('\x1b]2;FIXTURE-TITLE\x07')
process.stdin.on('data', (d) => process.stdout.write('ECHO[' + d.toString('hex') + ']'))
setInterval(() => {}, 1000)
