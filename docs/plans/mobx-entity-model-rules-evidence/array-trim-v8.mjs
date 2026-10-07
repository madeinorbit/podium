const N = 20000; const heap = () => { global.gc(); global.gc(); return process.memoryUsage().heapUsed }
const b = heap(); const xs = Array.from({ length: N }, () => { const a = new Array(100); a[0] = 1; a.length = 1; return a }); const a = heap()
const b2 = heap(); const ys = Array.from({ length: N }, () => { const a = new Array(1); a[0] = 1; return a }); const a2 = heap()
console.log('V8', process.version, { array100TrimmedTo1: Math.round((a - b) / N), array1: Math.round((a2 - b2) / N) }); void xs.length; void ys.length
