//! The output ring: a bounded window onto every byte the child ever wrote,
//! addressed by a monotonic byte sequence number.

pub struct Ring {
    /// Capacity `size`, filled only as far as output has reached: until the
    /// first wrap, bytes arrive in order at the end, so the untouched tail
    /// stays unallocated address space. (`vec![0; size]` goes through calloc,
    /// which on musl zero-fills — 4 MiB resident before the child writes a byte.)
    buf: Vec<u8>,
    size: usize,
    /// Bytes ever appended.
    high: u64,
}

impl Ring {
    pub fn new(size: usize) -> Ring {
        assert!(size > 0);
        Ring {
            buf: Vec::with_capacity(size),
            size,
            high: 0,
        }
    }

    pub fn size(&self) -> usize {
        self.size
    }

    pub fn high(&self) -> u64 {
        self.high
    }

    /// The oldest sequence number still held.
    pub fn low(&self) -> u64 {
        self.high.saturating_sub(self.size as u64)
    }

    pub fn append(&mut self, mut d: &[u8]) {
        let total = d.len() as u64; // every byte gets a number, kept or not
        let size = self.size;
        if d.len() >= size {
            d = &d[d.len() - size..];
        }
        // Place the first KEPT byte at its own number. host.c places it at
        // `seq_high % size` — the number of the first byte of the whole write —
        // which scrambles the ring whenever one read is larger than the ring and
        // not a multiple of it (reachable only with --ring-bytes < 64 KiB).
        let at = ((self.high + total - d.len() as u64) % size as u64) as usize;
        let first = (size - at).min(d.len());
        self.put(at, &d[..first]);
        self.put(0, &d[first..]);
        self.high += total;
    }

    /// Write `d` at position `at`, growing the filled part when `d` reaches past it.
    fn put(&mut self, at: usize, d: &[u8]) {
        let len = self.buf.len();
        if at + d.len() <= len {
            self.buf[at..at + d.len()].copy_from_slice(d);
        } else if at <= len {
            let (inside, beyond) = d.split_at(len - at);
            self.buf[at..].copy_from_slice(inside);
            self.buf.extend_from_slice(beyond);
        } else {
            // Only a ring-sized write into a ring not yet full lands past the
            // filled part; it then fills the whole ring anyway.
            self.buf.resize(at, 0);
            self.buf.extend_from_slice(d);
        }
    }

    /// Append the `n` bytes starting at `seq` to `out`. The caller keeps
    /// `low() <= seq` and `seq + n <= high()`.
    pub fn copy_to(&self, seq: u64, n: usize, out: &mut Vec<u8>) {
        let at = (seq % self.size as u64) as usize;
        let first = (self.size - at).min(n);
        out.extend_from_slice(&self.buf[at..at + first]);
        out.extend_from_slice(&self.buf[..n - first]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(r: &Ring, seq: u64, n: usize) -> Vec<u8> {
        let mut v = Vec::new();
        r.copy_to(seq, n, &mut v);
        v
    }

    #[test]
    fn empty_ring() {
        let r = Ring::new(8);
        assert_eq!((r.low(), r.high()), (0, 0));
    }

    #[test]
    fn append_within_capacity_keeps_everything() {
        let mut r = Ring::new(8);
        r.append(b"abc");
        r.append(b"de");
        assert_eq!((r.low(), r.high()), (0, 5));
        assert_eq!(read(&r, 0, 5), b"abcde");
        assert_eq!(read(&r, 2, 2), b"cd");
    }

    #[test]
    fn wraparound_keeps_the_newest_bytes_at_their_numbers() {
        let mut r = Ring::new(8);
        r.append(b"0123456");
        r.append(b"789AB");
        assert_eq!((r.low(), r.high()), (4, 12));
        assert_eq!(read(&r, 4, 8), b"456789AB");
        assert_eq!(read(&r, 7, 3), b"789");
    }

    #[test]
    fn a_write_larger_than_the_ring_numbers_every_byte() {
        let mut r = Ring::new(4);
        r.append(b"x");
        r.append(b"abcdefghij");
        assert_eq!(r.high(), 11);
        assert_eq!(r.low(), 7);
        assert_eq!(read(&r, 7, 4), b"ghij");
    }

    #[test]
    fn a_ring_sized_write_into_a_partly_filled_ring() {
        let mut r = Ring::new(4);
        r.append(b"x");
        r.append(b"abcdef"); // keeps cdef at seqs 3..7: position 3, then 0..3
        assert_eq!((r.low(), r.high()), (3, 7));
        assert_eq!(read(&r, 3, 4), b"cdef");
        r.append(b"g");
        assert_eq!(read(&r, 4, 4), b"defg");
    }

    #[test]
    fn nothing_is_resident_before_output() {
        let r = Ring::new(4 << 20);
        assert_eq!(r.buf.len(), 0);
        assert!(r.buf.capacity() >= 4 << 20);
    }

    #[test]
    fn exactly_ring_sized_writes() {
        let mut r = Ring::new(4);
        r.append(b"ab");
        r.append(b"cdef");
        assert_eq!((r.low(), r.high()), (2, 6));
        assert_eq!(read(&r, 2, 4), b"cdef");
    }

    #[test]
    fn matches_a_naive_model_under_many_sizes() {
        let mut all = Vec::new();
        let mut r = Ring::new(37);
        let mut x: u32 = 1;
        for i in 0..500 {
            x = x.wrapping_mul(1103515245).wrapping_add(12345);
            let n = (x >> 16) as usize % 90;
            let chunk: Vec<u8> = (0..n).map(|j| (i * 7 + j) as u8).collect();
            r.append(&chunk);
            all.extend_from_slice(&chunk);
            assert_eq!(r.high(), all.len() as u64);
            let low = r.low() as usize;
            assert_eq!(low, all.len().saturating_sub(37));
            assert_eq!(read(&r, low as u64, all.len() - low), &all[low..]);
        }
    }
}
