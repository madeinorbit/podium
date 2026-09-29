//! SPEC-6 wire protocol: frame types, error codes, frame encoding and the
//! incremental frame parser. Every frame is `u32 length` (big-endian, of the
//! rest), `u8 type`, payload; integers are big-endian.

pub const C_HELLO: u8 = 0x01;
pub const C_WRITE: u8 = 0x02;
pub const C_RESIZE: u8 = 0x03;
pub const C_SIZE: u8 = 0x04;
pub const C_STATUS: u8 = 0x05;
pub const C_SIGNAL: u8 = 0x06;
pub const C_DETACH: u8 = 0x07;
pub const C_KILL: u8 = 0x08;
pub const C_REPLAY: u8 = 0x09;
/// Deliberate takeover (POD-4434): revoke the current writer's lease and grant
/// it to the sender. Sent only on an explicit operator action, never as a retry.
pub const C_STEAL: u8 = 0x0A;

pub const H_WELCOME: u8 = 0x81;
pub const H_DATA: u8 = 0x82;
pub const H_GAP: u8 = 0x83;
pub const H_RESIZED: u8 = 0x84;
pub const H_SIZE: u8 = 0x85;
pub const H_STATUS: u8 = 0x86;
pub const H_WRITTEN: u8 = 0x87;
pub const H_EXITED: u8 = 0x88;
pub const H_LEASE_LOST: u8 = 0x89;
pub const H_REPLAYING: u8 = 0x8A;
pub const H_REPLAYED: u8 = 0x8B;
/// Ack for C_STEAL: the sender now holds the writer lease.
pub const H_STOLEN: u8 = 0x8C;
pub const H_ERR: u8 = 0x8F;

pub const ERR_NOT_WRITER: u16 = 1;
pub const ERR_NO_PTY: u16 = 2;
pub const ERR_BAD_FRAME: u16 = 3;
pub const ERR_EXITED: u16 = 4;
/// Rust port only: a WRITE refused because the input queue toward the child is
/// full (the child is not reading its input). host.c queues without a limit
/// (POD-4842 C-3); the connection survives this error.
pub const ERR_INPUT_FULL: u16 = 5;

pub const MODE_WRITER: u8 = 1;
pub const MODE_READER: u8 = 2;

pub const PROTO_VERSION: u16 = 1;

/// A client frame larger than this is malformed.
pub const MAX_FRAME: u32 = 1 << 20;
/// Bytes per DATA frame.
pub const DATA_CHUNK: usize = 32 * 1024;
/// A client whose control queue holds more than a whole ring replay plus this is not reading.
pub const MAX_OUTBUF_SLACK: usize = 1 << 20;
/// Bytes (plus [`WRITE_OVERHEAD`] per write) the input queue toward the child
/// may hold; a WRITE beyond it is refused with ERR_INPUT_FULL.
pub const MAX_INPUT_QUEUE: usize = 1 << 20;
/// What one queued write costs besides its bytes, so a flood of empty WRITEs
/// is bounded too.
pub const WRITE_OVERHEAD: usize = 64;
/// `fromSeq` meaning "tail only".
pub const TAIL_ONLY: u64 = u64::MAX;

/// One outgoing frame being appended to a buffer. The length word is patched
/// when the frame is dropped, so a frame cannot be left unterminated.
pub struct Frame<'a> {
    buf: &'a mut Vec<u8>,
    at: usize,
}

impl<'a> Frame<'a> {
    pub fn begin(buf: &'a mut Vec<u8>, ty: u8) -> Self {
        let at = buf.len();
        buf.extend_from_slice(&[0, 0, 0, 0, ty]);
        Frame { buf, at }
    }
    pub fn u8(&mut self, v: u8) -> &mut Self {
        self.buf.push(v);
        self
    }
    pub fn u16(&mut self, v: u16) -> &mut Self {
        self.buf.extend_from_slice(&v.to_be_bytes());
        self
    }
    pub fn u32(&mut self, v: u32) -> &mut Self {
        self.buf.extend_from_slice(&v.to_be_bytes());
        self
    }
    pub fn i32(&mut self, v: i32) -> &mut Self {
        self.buf.extend_from_slice(&v.to_be_bytes());
        self
    }
    pub fn u64(&mut self, v: u64) -> &mut Self {
        self.buf.extend_from_slice(&v.to_be_bytes());
        self
    }
    pub fn bytes(&mut self, d: &[u8]) -> &mut Self {
        self.buf.extend_from_slice(d);
        self
    }
    /// The buffer the payload is being written into (for in-place ring copies).
    pub fn buf(&mut self) -> &mut Vec<u8> {
        self.buf
    }
}

impl Drop for Frame<'_> {
    fn drop(&mut self) {
        let n = (self.buf.len() - self.at - 4) as u32;
        self.buf[self.at..self.at + 4].copy_from_slice(&n.to_be_bytes());
    }
}

/// Queue an ERR frame: `u16 code`, `u32 len`, message bytes.
pub fn err(out: &mut Vec<u8>, code: u16, msg: &str) {
    Frame::begin(out, H_ERR)
        .u16(code)
        .u32(msg.len() as u32)
        .bytes(msg.as_bytes());
}

/// Queue an ERR frame that refuses a WRITE: the same layout plus the write's
/// `u32 id` after the message, so the client rejects exactly that write. An
/// ERR carries no id otherwise, and a client matching it to the oldest
/// pending request would reject the wrong one. Older clients read only up to
/// the message and ignore the trailing bytes. Rust port only (host.c sends no id).
pub fn err_write(out: &mut Vec<u8>, code: u16, msg: &str, write_id: u32) {
    Frame::begin(out, H_ERR)
        .u16(code)
        .u32(msg.len() as u32)
        .bytes(msg.as_bytes())
        .u32(write_id);
}

/// What the front of an input buffer holds.
#[derive(Debug, PartialEq, Eq)]
pub enum Next {
    /// Not a whole frame yet.
    Incomplete,
    /// The length word is 0 or above MAX_FRAME: the connection must go.
    BadLength,
    /// A whole frame of `total` bytes (length word included); its payload is
    /// `buf[5..total]`.
    Frame { ty: u8, total: usize },
}

pub fn next_frame(buf: &[u8]) -> Next {
    if buf.len() < 5 {
        return Next::Incomplete;
    }
    let len = rd_u32(buf);
    if !(1..=MAX_FRAME).contains(&len) {
        return Next::BadLength;
    }
    let total = 4 + len as usize;
    if buf.len() < total {
        return Next::Incomplete;
    }
    Next::Frame { ty: buf[4], total }
}

/// A client frame, decoded and length-checked. The lease, pty and exit
/// checks are the host's; everything knowable from the bytes alone is here.
#[derive(Debug, PartialEq, Eq)]
pub enum Request<'a> {
    Hello { writer: bool, from: u64 },
    Write { id: u32, data: &'a [u8] },
    Resize { cols: u16, rows: u16 },
    Size,
    Status,
    Signal(u8),
    Detach,
    Kill,
    Replay { tail: u32 },
    Steal,
}

/// Decode one frame's payload. Errors are the ERR messages host.c sends
/// before closing the connection. SIZE, STATUS, DETACH and KILL accept any
/// payload, as in host.c.
pub fn parse_request(ty: u8, p: &[u8]) -> Result<Request<'_>, &'static str> {
    const BAD: &str = "bad frame";
    let exact = |n: usize| if p.len() == n { Ok(()) } else { Err(BAD) };
    Ok(match ty {
        C_HELLO => {
            if p.len() != 2 + 1 + 8 {
                return Err("bad HELLO");
            }
            let (version, mode) = (rd_u16(p), p[2]);
            if version != PROTO_VERSION || (mode != MODE_WRITER && mode != MODE_READER) {
                return Err("unsupported HELLO");
            }
            Request::Hello {
                writer: mode == MODE_WRITER,
                from: rd_u64(&p[3..]),
            }
        }
        C_WRITE if p.len() >= 4 => Request::Write {
            id: rd_u32(p),
            data: &p[4..],
        },
        C_RESIZE => {
            exact(4)?;
            Request::Resize {
                cols: rd_u16(p),
                rows: rd_u16(&p[2..]),
            }
        }
        C_SIZE => Request::Size,
        C_STATUS => Request::Status,
        C_SIGNAL => {
            exact(1)?;
            Request::Signal(p[0])
        }
        C_DETACH => Request::Detach,
        C_KILL => Request::Kill,
        C_REPLAY => {
            exact(4)?;
            Request::Replay { tail: rd_u32(p) }
        }
        C_STEAL => {
            exact(0)?;
            Request::Steal
        }
        _ => return Err(BAD),
    })
}

pub fn rd_u16(p: &[u8]) -> u16 {
    u16::from_be_bytes([p[0], p[1]])
}
pub fn rd_u32(p: &[u8]) -> u32 {
    u32::from_be_bytes([p[0], p[1], p[2], p[3]])
}
pub fn rd_u64(p: &[u8]) -> u64 {
    u64::from_be_bytes(p[..8].try_into().unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_patches_its_length_on_drop() {
        let mut b = vec![0xEE];
        Frame::begin(&mut b, H_RESIZED).u16(120).u16(40).u8(1);
        assert_eq!(b, [0xEE, 0, 0, 0, 6, H_RESIZED, 0, 120, 0, 40, 1]);
    }

    #[test]
    fn empty_frame_has_length_one() {
        let mut b = Vec::new();
        Frame::begin(&mut b, H_STOLEN);
        assert_eq!(b, [0, 0, 0, 1, H_STOLEN]);
    }

    #[test]
    fn err_frame_layout() {
        let mut b = Vec::new();
        err(&mut b, ERR_NOT_WRITER, "not the writer");
        assert_eq!(rd_u32(&b) as usize, b.len() - 4);
        assert_eq!(b[4], H_ERR);
        assert_eq!(rd_u16(&b[5..]), 1);
        assert_eq!(rd_u32(&b[7..]), 14);
        assert_eq!(&b[11..], b"not the writer");
    }

    #[test]
    fn a_refused_write_carries_its_id_after_the_message() {
        let mut b = Vec::new();
        err_write(&mut b, ERR_INPUT_FULL, "input queue full", 0xDEADBEEF);
        assert_eq!(rd_u32(&b) as usize, b.len() - 4);
        assert_eq!(rd_u16(&b[5..]), ERR_INPUT_FULL);
        assert_eq!(rd_u32(&b[7..]), 16);
        assert_eq!(&b[11..27], b"input queue full");
        assert_eq!(rd_u32(&b[27..]), 0xDEADBEEF);
        assert_eq!(b.len(), 31);
    }

    #[test]
    fn integers_are_big_endian() {
        let mut b = Vec::new();
        Frame::begin(&mut b, H_EXITED)
            .i32(-1)
            .u64(0x0102030405060708);
        assert_eq!(&b[5..9], &[0xFF, 0xFF, 0xFF, 0xFF]);
        assert_eq!(rd_u64(&b[9..]), 0x0102030405060708);
    }

    #[test]
    fn parser_waits_for_a_whole_frame_fed_byte_by_byte() {
        let mut hello = Vec::new();
        Frame::begin(&mut hello, C_HELLO)
            .u16(1)
            .u8(MODE_WRITER)
            .u64(TAIL_ONLY);
        for cut in 0..hello.len() {
            assert_eq!(next_frame(&hello[..cut]), Next::Incomplete, "cut at {cut}");
        }
        assert_eq!(
            next_frame(&hello),
            Next::Frame {
                ty: C_HELLO,
                total: 16
            }
        );
    }

    #[test]
    fn parser_sees_only_the_first_of_two_frames() {
        let mut b = Vec::new();
        Frame::begin(&mut b, C_STATUS);
        Frame::begin(&mut b, C_SIZE);
        assert_eq!(
            next_frame(&b),
            Next::Frame {
                ty: C_STATUS,
                total: 5
            }
        );
        assert_eq!(
            next_frame(&b[5..]),
            Next::Frame {
                ty: C_SIZE,
                total: 5
            }
        );
    }

    #[test]
    fn parser_refuses_zero_and_oversized_lengths() {
        assert_eq!(next_frame(&[0, 0, 0, 0, 1]), Next::BadLength);
        let big = (MAX_FRAME + 1).to_be_bytes();
        assert_eq!(
            next_frame(&[big[0], big[1], big[2], big[3], 2]),
            Next::BadLength
        );
        let max = MAX_FRAME.to_be_bytes();
        assert_eq!(
            next_frame(&[max[0], max[1], max[2], max[3], 2]),
            Next::Incomplete
        );
    }

    #[test]
    fn requests_decode() {
        let mut hello = Vec::new();
        Frame::begin(&mut hello, 0).u16(1).u8(MODE_READER).u64(42);
        assert_eq!(
            parse_request(C_HELLO, &hello[5..]),
            Ok(Request::Hello {
                writer: false,
                from: 42
            })
        );
        assert_eq!(
            parse_request(C_WRITE, &[0, 0, 0, 7, b'h', b'i']),
            Ok(Request::Write { id: 7, data: b"hi" })
        );
        assert_eq!(
            parse_request(C_WRITE, &[0, 0, 0, 7]),
            Ok(Request::Write { id: 7, data: b"" })
        );
        assert_eq!(
            parse_request(C_RESIZE, &[0, 120, 0, 40]),
            Ok(Request::Resize {
                cols: 120,
                rows: 40
            })
        );
        assert_eq!(parse_request(C_SIGNAL, &[15]), Ok(Request::Signal(15)));
        assert_eq!(
            parse_request(C_REPLAY, &[0, 0, 1, 0]),
            Ok(Request::Replay { tail: 256 })
        );
        assert_eq!(parse_request(C_STEAL, &[]), Ok(Request::Steal));
        // host.c checks no length for these four
        assert_eq!(parse_request(C_SIZE, b"junk"), Ok(Request::Size));
        assert_eq!(parse_request(C_STATUS, b""), Ok(Request::Status));
        assert_eq!(parse_request(C_DETACH, b"x"), Ok(Request::Detach));
        assert_eq!(parse_request(C_KILL, b"x"), Ok(Request::Kill));
    }

    #[test]
    fn malformed_requests_carry_host_c_messages() {
        assert_eq!(parse_request(C_HELLO, &[0, 1, 1]), Err("bad HELLO"));
        let mut v2 = Vec::new();
        Frame::begin(&mut v2, 0).u16(2).u8(MODE_WRITER).u64(0);
        assert_eq!(parse_request(C_HELLO, &v2[5..]), Err("unsupported HELLO"));
        let mut mode3 = Vec::new();
        Frame::begin(&mut mode3, 0).u16(1).u8(3).u64(0);
        assert_eq!(
            parse_request(C_HELLO, &mode3[5..]),
            Err("unsupported HELLO")
        );
        for (ty, p) in [
            (C_WRITE, &[0u8, 0, 0][..]),
            (C_RESIZE, &[0, 80, 0][..]),
            (C_SIGNAL, &[][..]),
            (C_SIGNAL, &[1, 2][..]),
            (C_REPLAY, &[0, 0, 0, 0, 0][..]),
            (C_STEAL, &[0][..]),
            (0x00, &[][..]),
            (0x0B, &[][..]),
            (H_DATA, &[][..]),
        ] {
            assert_eq!(parse_request(ty, p), Err("bad frame"), "type {ty:#x}");
        }
    }
}
