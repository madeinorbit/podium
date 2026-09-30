//! The host keeps the terminal's screen (POD-4909; prototype and numbers on
//! POD-4861). Every byte the ring takes is fed to an in-process emulator
//! (alacritty_terminal), and a picture is an ANSI redraw of the whole state:
//! written to a fresh terminal of the same size, it reproduces the stream up
//! to the ring's high seq, so "picture, then DATA from there" is exact.
//!
//! The emulator is only ever stopped at parser ground state. vte (alacritty's
//! parser) does not say whether it is at ground, so [`Ground`] mirrors its state
//! machine and the feed holds back an unfinished escape sequence or UTF-8
//! character until it completes. The picture is the state at that ground
//! point followed by the held bytes, which the DATA after it completes. A
//! sequence longer than [`HOLD_MAX`] (a huge OSC or DCS string) is fed through
//! instead; until the parser returns to ground, pictures wait.

use std::cell::RefCell;
use std::fmt::Write as _;
use std::rc::Rc;

use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::{Dimensions, Grid};
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::{Cell, Flags, Hyperlink};
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::vte::ansi::{Color, CursorShape, NamedColor, Processor, Timeout};

/// The longest unfinished sequence held back from the emulator.
pub const HOLD_MAX: usize = 64 * 1024;
pub const DEFAULT_SCROLLBACK: usize = 1000;
/// The most a picture takes: scrollback lines are dropped from the top until
/// it fits. The visible screens are always sent whole.
pub const PICTURE_BUDGET: usize = 1 << 20;

/// Receives what the terminal would tell its window: only the title matters here.
/// Replies to queries (DA, DSR) are dropped; the real terminal answers them.
#[derive(Clone, Default)]
struct Listener(Rc<RefCell<Option<String>>>);

impl EventListener for Listener {
    fn send_event(&self, e: Event) {
        match e {
            Event::Title(t) => *self.0.borrow_mut() = Some(t),
            Event::ResetTitle => *self.0.borrow_mut() = None,
            _ => {}
        }
    }
}

/// Synchronized updates (mode 2026) buffer output for a renderer; the host
/// renders nothing, so it never buffers.
#[derive(Default)]
struct NoSync;

impl Timeout for NoSync {
    fn set_timeout(&mut self, _: std::time::Duration) {}
    fn clear_timeout(&mut self) {}
    fn pending_timeout(&self) -> bool {
        false
    }
}

struct Size {
    cols: usize,
    rows: usize,
}

impl Dimensions for Size {
    fn total_lines(&self) -> usize {
        self.rows
    }
    fn screen_lines(&self) -> usize {
        self.rows
    }
    fn columns(&self) -> usize {
        self.cols
    }
}

/// vte's parser states, collapsed to what decides "at ground" and "ends here".
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum St {
    Ground,
    Utf8(u8),
    Esc,
    EscInt,
    Csi,
    DcsEntry,
    DcsParam,
    DcsInt,
    DcsIgnore,
    DcsPass,
    Osc,
    SosPmApc,
}

/// A mirror of vte 0.15's state machine (`Parser::advance`): the same
/// transitions, no actions except recording DECSTBM, which alacritty_terminal
/// keeps private and the picture must restore.
struct Ground {
    st: St,
    /// CSI bookkeeping for DECSTBM: params, and whether a private marker or
    /// intermediate was seen (then it is not DECSTBM).
    params: [u32; 2],
    nparam: usize,
    plain: bool,
    /// Raw DECSTBM params as last dispatched (top, bottom; 0 = default).
    region: Option<(u32, u32)>,
    /// CSI began with the private marker `?` (and nothing else disqualified it).
    private: bool,
    /// Synchronized output (mode 2026) is on: alacritty tracks it only inside
    /// its sync buffer, which the host disables, so the mirror keeps it.
    sync: bool,
}

impl Ground {
    fn new() -> Self {
        Ground {
            st: St::Ground,
            params: [0; 2],
            nparam: 0,
            plain: true,
            region: None,
            private: false,
            sync: false,
        }
    }

    fn csi_start(&mut self) {
        self.params = [0; 2];
        self.nparam = 0;
        self.plain = true;
        self.private = false;
    }

    fn csi_dispatch(&mut self, b: u8) {
        if (b == b'h' || b == b'l')
            && self.private
            && !self.plain
            && self.params[..=self.nparam.min(1)].contains(&2026)
        {
            self.sync = b == b'h';
        }
        if b == b'r' && self.plain {
            // an invalid region (top >= bottom) is ignored, as alacritty does;
            // bottom 0 means the last line, which only the caller knows
            let (t, b) = (self.params[0].max(1), self.params[1]);
            if b == 0 || t < b {
                self.region = Some((t, b));
            }
        }
        self.st = St::Ground;
    }

    /// Advance over `bytes`; the last offset after which the parser is at
    /// ground. Plain ASCII at ground is skipped without stepping.
    fn last_ground(&mut self, bytes: &[u8]) -> Option<usize> {
        let mut cut = None;
        let mut i = 0;
        while i < bytes.len() {
            if self.st == St::Ground {
                match bytes[i..].iter().position(|&b| b == 0x1B || b >= 0x80) {
                    None => return Some(bytes.len()),
                    Some(0) => {}
                    Some(p) => {
                        i += p;
                        cut = Some(i);
                    }
                }
            }
            if self.step(bytes[i]) {
                cut = Some(i + 1);
            }
            i += 1;
        }
        cut
    }

    /// Advance over one byte; true when the parser is at ground after it.
    #[inline]
    fn step(&mut self, b: u8) -> bool {
        use St::*;
        self.st = match (self.st, b) {
            (Ground, 0x1B) => Esc,
            (Ground, 0xC2..=0xDF) => Utf8(1),
            (Ground, 0xE0..=0xEF) => Utf8(2),
            (Ground, 0xF0..=0xF4) => Utf8(3),
            (Ground, _) => Ground,
            (Utf8(n), 0x80..=0xBF) => {
                if n > 1 {
                    Utf8(n - 1)
                } else {
                    Ground
                }
            }
            (Utf8(_), _) => {
                // vte drops the partial character and reads this byte afresh
                self.st = Ground;
                return self.step(b);
            }
            // vte's "anywhere" transitions, the same in every other state
            (_, 0x18 | 0x1A) => Ground,
            (_, 0x1B) => Esc,
            (Esc, 0x20..=0x2F) => EscInt,
            (Esc, 0x50) => DcsEntry,
            (Esc, 0x58 | 0x5E | 0x5F) => SosPmApc,
            (Esc, 0x5B) => {
                self.csi_start();
                Csi
            }
            (Esc, 0x5D) => Osc,
            (Esc, b'c') => {
                self.region = None; // RIS
                self.sync = false;
                Ground
            }
            (Esc | EscInt, 0x30..=0x7E) => Ground,
            (Csi, 0x30..=0x39) => {
                if self.nparam < 2 {
                    let p = &mut self.params[self.nparam];
                    *p = p.saturating_mul(10).saturating_add((b - b'0') as u32);
                }
                Csi
            }
            (Csi, b';') => {
                self.nparam += 1;
                Csi
            }
            // `?` first: a DEC private mode (kept for mode 2026)
            (Csi, b'?')
                if self.plain && self.nparam == 0 && self.params[0] == 0 && !self.private =>
            {
                self.plain = false;
                self.private = true;
                Csi
            }
            // sub-parameters, other private markers, intermediates: neither
            (Csi, 0x20..=0x2F | 0x3A | 0x3C..=0x3F) => {
                self.plain = false;
                self.private = false;
                Csi
            }
            (Csi, 0x40..=0x7E) => {
                self.csi_dispatch(b);
                return true;
            }
            (DcsEntry, 0x20..=0x2F) | (DcsParam, 0x20..=0x2F) => DcsInt,
            (DcsEntry, 0x30..=0x3F) | (DcsParam, 0x30..=0x3B) => DcsParam,
            (DcsParam, 0x3C..=0x3F) | (DcsInt, 0x30..=0x3F) => DcsIgnore,
            (DcsEntry | DcsParam | DcsInt, 0x40..=0x7E) => DcsPass,
            (DcsPass, 0x9C) => Ground,
            (Osc, 0x07) => Ground,
            (st, _) => st,
        };
        self.st == Ground
    }
}

pub struct Screen {
    term: Term<Listener>,
    parser: Processor<NoSync>,
    title: Rc<RefCell<Option<String>>>,
    ground: Ground,
    /// Ring seq the emulator has consumed through; a ground point unless `overflowed`.
    fed: u64,
    /// Bytes after `fed` held back because they end inside a sequence.
    held: Vec<u8>,
    /// A held sequence outgrew HOLD_MAX and was fed: `fed` is not a ground point
    /// until the parser returns to ground.
    overflowed: bool,
    /// A 1x1 grid parked in the alternate screen's place while a picture
    /// reads the primary one (see `picture`).
    spare: Grid<Cell>,
}

impl Screen {
    pub fn new(cols: u16, rows: u16, scrollback: usize) -> Screen {
        let listener = Listener::default();
        let title = listener.0.clone();
        let cfg = Config {
            scrolling_history: scrollback,
            kitty_keyboard: true,
            ..Default::default()
        };
        let size = Size {
            cols: cols.max(1) as usize,
            rows: rows.max(1) as usize,
        };
        Screen {
            term: Term::new(cfg, &size, listener),
            parser: Processor::new(),
            title,
            ground: Ground::new(),
            fed: 0,
            held: Vec::new(),
            overflowed: false,
            spare: Grid::new(1, 1, 0),
        }
    }

    /// The same bytes the ring just appended, in order.
    pub fn feed(&mut self, bytes: &[u8]) {
        match self.ground.last_ground(bytes) {
            Some(n) => {
                self.fed += (self.held.len() + n) as u64;
                if self.held.is_empty() {
                    self.parser.advance(&mut self.term, &bytes[..n]);
                } else {
                    // One call, never the held part alone: vte 0.15.0 drops the
                    // byte after a character it was handed in part.
                    let mut held = std::mem::take(&mut self.held);
                    held.extend_from_slice(&bytes[..n]);
                    self.parser.advance(&mut self.term, &held);
                    held.clear();
                    self.held = held;
                }
                self.overflowed = false;
                self.hold(&bytes[n..]);
            }
            None => self.hold(bytes),
        }
    }

    fn hold(&mut self, rest: &[u8]) {
        self.held.extend_from_slice(rest);
        if self.held.len() > HOLD_MAX {
            let held = std::mem::take(&mut self.held);
            self.parser.advance(&mut self.term, &held);
            self.fed += held.len() as u64;
            self.overflowed = true;
        }
    }

    /// True when a picture now is exact: the emulator stopped at ground.
    pub fn at_ground(&self) -> bool {
        !self.overflowed
    }

    /// Bytes the emulator has consumed; the rest of what was fed is held.
    pub fn fed_seq(&self) -> u64 {
        self.fed
    }

    pub fn held_len(&self) -> usize {
        self.held.len()
    }

    pub fn size(&self) -> (u16, u16) {
        (self.term.columns() as u16, self.term.screen_lines() as u16)
    }

    /// Apply a size the host just set on the pty (TIOCSWINSZ).
    pub fn resize(&mut self, cols: u16, rows: u16) {
        let size = Size {
            cols: cols.max(1) as usize,
            rows: rows.max(1) as usize,
        };
        self.term.resize(size);
        // alacritty resets the scrolling region on resize
        self.ground.region = None;
    }

    /// The scrolling region as 1-based (top, bottom), None for the whole screen.
    /// alacritty ignores a region with top >= bottom and keeps the old one; so
    /// does [`Ground`], which records only a valid one.
    fn region(&self) -> Option<(u32, u32)> {
        let rows = self.term.screen_lines() as u32;
        let (t, b) = self.ground.region?;
        let (t, b) = (t.max(1), if b == 0 { rows } else { b.min(rows) });
        (t < b && (t, b) != (1, rows)).then_some((t, b))
    }

    /// Append the full state as bytes for a fresh terminal of `size()`:
    /// reset, scrollback and screen with attributes, alternate screen, saved
    /// cursor, scrolling region, modes, pen and cursor, then the held bytes.
    /// Returns true when scrollback was dropped to keep within
    /// [`PICTURE_BUDGET`].
    pub fn picture(&mut self, out: &mut Vec<u8>) -> bool {
        let start = out.len();
        out.extend_from_slice(b"\x1bc");
        let mut link = None; // the hyperlink written last
        let mut cuts = Vec::new(); // where history lines may be dropped from
        let alt = self.term.mode().contains(TermMode::ALT_SCREEN);
        if alt {
            // The primary grid is private while the alternate screen is up;
            // swap_alt() reaches it. Swapping back in resets whatever grid is
            // parked as the alternate one, so the spare is parked there in
            // the alternate grid's place, and the alternate grid is put back
            // after. Nothing is copied.
            std::mem::swap(self.term.grid_mut(), &mut self.spare);
            self.term.swap_alt();
            write_grid(self.term.grid(), Some(&mut cuts), &mut link, out);
            // The primary cursor and its pen: entering the alternate screen
            // keeps both for when the program leaves it.
            let c = &self.term.grid().cursor;
            cup(out, c.point.line.0 + 1, c.point.column.0 + 1);
            sgr(out, &c.template, &mut link);
            self.term.swap_alt();
            std::mem::swap(self.term.grid_mut(), &mut self.spare);
            out.extend_from_slice(b"\x1b[?1049h\x1b[H");
            write_grid(self.term.grid(), None, &mut link, out);
        } else {
            write_grid(self.term.grid(), Some(&mut cuts), &mut link, out);
        }
        let grid = self.term.grid();
        let mode = *self.term.mode();

        // Saved cursor (DECSC) of the active screen
        let sc = &grid.saved_cursor;
        cup(out, sc.point.line.0 + 1, sc.point.column.0 + 1);
        sgr(out, &sc.template, &mut link);
        out.extend_from_slice(b"\x1b7");

        // Scrolling region and origin mode (both home the cursor)
        let mut top = 0;
        if let Some((t, b)) = self.region() {
            let _ = write!(Str(out), "\x1b[{t};{b}r");
            top = t as i32 - 1;
        }
        if mode.contains(TermMode::ORIGIN) {
            out.extend_from_slice(b"\x1b[?6h");
        } else {
            top = 0;
        }

        // Cursor, pending wrap, pen
        let cur = &grid.cursor;
        let (line, col) = (cur.point.line.0, cur.point.column.0);
        if cur.input_needs_wrap {
            // Re-print the last cell so the cursor waits to wrap, as it did
            let cell = &grid[Line(line)][Column(col)];
            cup(out, line - top + 1, col + 1);
            sgr(out, cell, &mut link);
            put_cell(out, cell);
        } else {
            cup(out, line - top + 1, col + 1);
        }
        sgr(out, &cur.template, &mut link);

        // Modes
        let set = |out: &mut Vec<u8>, m: TermMode, seq: &[u8]| {
            if mode.contains(m) {
                out.extend_from_slice(seq);
            }
        };
        set(out, TermMode::APP_CURSOR, b"\x1b[?1h");
        set(out, TermMode::APP_KEYPAD, b"\x1b=");
        set(out, TermMode::BRACKETED_PASTE, b"\x1b[?2004h");
        set(out, TermMode::MOUSE_REPORT_CLICK, b"\x1b[?1000h");
        set(out, TermMode::MOUSE_DRAG, b"\x1b[?1002h");
        set(out, TermMode::MOUSE_MOTION, b"\x1b[?1003h");
        set(out, TermMode::FOCUS_IN_OUT, b"\x1b[?1004h");
        set(out, TermMode::UTF8_MOUSE, b"\x1b[?1005h");
        set(out, TermMode::SGR_MOUSE, b"\x1b[?1006h");
        set(out, TermMode::INSERT, b"\x1b[4h");
        set(out, TermMode::LINE_FEED_NEW_LINE, b"\x1b[20h");
        if !mode.contains(TermMode::ALTERNATE_SCROLL) {
            out.extend_from_slice(b"\x1b[?1007l");
        }
        if !mode.contains(TermMode::LINE_WRAP) {
            out.extend_from_slice(b"\x1b[?7l");
        }
        let kitty = (mode.bits() >> 18) & 0x1F;
        if kitty != 0 {
            let _ = write!(Str(out), "\x1b[>{kitty}u");
        }
        let style = self.term.cursor_style();
        if style != Default::default() {
            let n = match style.shape {
                CursorShape::Underline => 4,
                CursorShape::Beam => 6,
                _ => 2,
            } - style.blinking as u8;
            let _ = write!(Str(out), "\x1b[{n} q");
        }
        if let Some(t) = self.title.borrow().as_deref() {
            let _ = write!(Str(out), "\x1b]2;{t}\x07");
        }
        if !mode.contains(TermMode::SHOW_CURSOR) {
            out.extend_from_slice(b"\x1b[?25l");
        }
        // Last of the state: a client that honours it holds the picture until
        // the ?2026l the program sends next, as it would have held the live frame.
        if self.ground.sync {
            out.extend_from_slice(b"\x1b[?2026h");
        }

        let trimmed = trim_history(out, start, &cuts, self.held.len());
        // The unfinished sequence: the DATA after the picture completes it.
        out.extend_from_slice(&self.held);
        trimmed
    }
}

/// Drop whole history lines from the top of the picture at `out[start..]`
/// until it and `extra` bytes fit the budget, or no history is left to drop.
/// `cuts` are the offsets of the history's logical line starts, top first;
/// at each the pen is the default and no link is open.
fn trim_history(out: &mut Vec<u8>, start: usize, cuts: &[usize], extra: usize) -> bool {
    let len = out.len() - start + extra;
    let Some(&first) = cuts.first() else {
        return false;
    };
    if len <= PICTURE_BUDGET {
        return false;
    }
    let excess = len - PICTURE_BUDGET;
    let to = cuts
        .iter()
        .copied()
        .find(|&c| c - first >= excess)
        .unwrap_or(cuts[cuts.len() - 1]);
    out.drain(first..to);
    to > first
}

struct Str<'a>(&'a mut Vec<u8>);

impl std::fmt::Write for Str<'_> {
    fn write_str(&mut self, s: &str) -> std::fmt::Result {
        self.0.extend_from_slice(s.as_bytes());
        Ok(())
    }
}

fn cup(out: &mut Vec<u8>, row: i32, col: usize) {
    let _ = write!(Str(out), "\x1b[{};{}H", row.max(1), col.max(1));
}

const ATTRS: Flags = Flags::BOLD
    .union(Flags::DIM)
    .union(Flags::ITALIC)
    .union(Flags::ALL_UNDERLINES)
    .union(Flags::INVERSE)
    .union(Flags::HIDDEN)
    .union(Flags::STRIKEOUT);

fn same_pen(a: &Cell, b: &Cell) -> bool {
    a.fg == b.fg
        && a.bg == b.bg
        && (a.flags & ATTRS) == (b.flags & ATTRS)
        && a.underline_color() == b.underline_color()
        && a.hyperlink() == b.hyperlink()
}

fn color(out: &mut Vec<u8>, c: Color, base: u8) {
    let mut s = Str(out);
    let _ = match c {
        Color::Named(n) => {
            let i = n as usize;
            let i = if (NamedColor::DimBlack as usize..=NamedColor::DimWhite as usize).contains(&i)
            {
                i - NamedColor::DimBlack as usize
            } else {
                i
            };
            match i {
                0..=7 => write!(s, ";{}", base as usize + i),
                8..=15 => write!(s, ";{}", base as usize + 60 + i - 8),
                _ => Ok(()), // default foreground/background
            }
        }
        Color::Indexed(i) => write!(s, ";{};5;{i}", base + 8),
        Color::Spec(rgb) => write!(s, ";{};2;{};{};{}", base + 8, rgb.r, rgb.g, rgb.b),
    };
}

/// A full SGR for a cell's pen (reset first), and its hyperlink when that is
/// not `link`, the one written last.
fn sgr(out: &mut Vec<u8>, c: &Cell, link: &mut Option<Hyperlink>) {
    out.extend_from_slice(b"\x1b[0");
    let f = c.flags;
    for (flag, code) in [
        (Flags::BOLD, ";1"),
        (Flags::DIM, ";2"),
        (Flags::ITALIC, ";3"),
        (Flags::UNDERLINE, ";4"),
        (Flags::DOUBLE_UNDERLINE, ";4:2"),
        (Flags::UNDERCURL, ";4:3"),
        (Flags::DOTTED_UNDERLINE, ";4:4"),
        (Flags::DASHED_UNDERLINE, ";4:5"),
        (Flags::INVERSE, ";7"),
        (Flags::HIDDEN, ";8"),
        (Flags::STRIKEOUT, ";9"),
    ] {
        if f.contains(flag) {
            out.extend_from_slice(code.as_bytes());
        }
    }
    color(out, c.fg, 30);
    color(out, c.bg, 40);
    match c.underline_color() {
        Some(Color::Indexed(i)) => {
            let _ = write!(Str(out), ";58:5:{i}");
        }
        Some(Color::Spec(rgb)) => {
            let _ = write!(Str(out), ";58:2::{}:{}:{}", rgb.r, rgb.g, rgb.b);
        }
        _ => {}
    }
    out.push(b'm');
    let h = c.hyperlink();
    if h != *link {
        match &h {
            Some(h) => {
                let _ = write!(Str(out), "\x1b]8;id={};{}\x1b\\", h.id(), h.uri());
            }
            None => out.extend_from_slice(b"\x1b]8;;\x1b\\"),
        }
        *link = h;
    }
}

fn put_cell(out: &mut Vec<u8>, c: &Cell) {
    let mut b = [0u8; 4];
    let ch = if c.c == '\0' { ' ' } else { c.c };
    out.extend_from_slice(ch.encode_utf8(&mut b).as_bytes());
    if let Some(zw) = c.zerowidth() {
        for z in zw {
            out.extend_from_slice(z.encode_utf8(&mut b).as_bytes());
        }
    }
}

fn is_blank(c: &Cell) -> bool {
    (c.c == ' ' || c.c == '\0')
        && c.bg == Color::Named(NamedColor::Background)
        && (c.flags & (ATTRS - Flags::BOLD - Flags::DIM - Flags::ITALIC)).is_empty()
        && c.extra.is_none()
}

/// Every line of the grid, scrollback first when `cuts` is given, top to
/// bottom: rows end in CRLF unless they wrapped (then the next character wraps
/// them), so a fresh terminal scrolls the history into its own scrollback.
/// `cuts` gets the offset of every logical line start down to the first
/// screen row: the pen is the default there, and no link is open.
fn write_grid(
    grid: &Grid<Cell>,
    mut cuts: Option<&mut Vec<usize>>,
    link: &mut Option<Hyperlink>,
    out: &mut Vec<u8>,
) {
    let top = if cuts.is_some() {
        -(grid.history_size() as i32)
    } else {
        0
    };
    let bottom = grid.screen_lines() as i32 - 1;
    let cols = grid.columns();
    let default = Cell::default();
    let mut pen: &Cell = &default;
    let mut prev_wrapped = false;
    out.extend_from_slice(b"\x1b[0m");
    if link.take().is_some() {
        out.extend_from_slice(b"\x1b]8;;\x1b\\");
    }
    for l in top..=bottom {
        if let Some(cuts) = cuts.as_deref_mut().filter(|_| l <= 0 && !prev_wrapped) {
            cuts.push(out.len());
        }
        let row = &grid[Line(l)];
        let wrapped = row[Column(cols - 1)].flags.contains(Flags::WRAPLINE);
        let mut end = cols;
        if !wrapped {
            while end > 0 && is_blank(&row[Column(end - 1)]) {
                end -= 1;
            }
            if prev_wrapped && end == 0 {
                end = 1; // keep the wrap into this row
            }
        }
        for c in 0..end {
            let cell = &row[Column(c)];
            // A spacer is skipped only behind its wide character (printing that
            // fills both cells); an orphan one is written as a blank. So is the
            // placeholder a wrapped wide character left at the end of a line:
            // the row then fills and wraps the same way, in the cell's colours.
            let behind_wide = c > 0 && row[Column(c - 1)].flags.contains(Flags::WIDE_CHAR);
            if cell.flags.contains(Flags::WIDE_CHAR_SPACER) && behind_wide {
                continue;
            }
            if !same_pen(pen, cell) {
                sgr(out, cell, link);
                pen = cell;
            }
            if cell.flags.contains(Flags::WIDE_CHAR)
                && !(c + 1 < cols && row[Column(c + 1)].flags.contains(Flags::WIDE_CHAR_SPACER))
            {
                // Lost its spacer (ICH pushed it off the line): no terminal can
                // print that, and printing it would wrap. Written as a blank.
                out.push(b' ');
                continue;
            }
            put_cell(out, cell);
        }
        if prev_wrapped && end < cols {
            // This row began with an implicit wrap; if that scrolled, the new
            // line took the pen's background (BCE). Clear the trimmed tail.
            if !same_pen(pen, &default) {
                sgr(out, &default, link);
                pen = &default;
            }
            out.extend_from_slice(b"\x1b[K");
        }
        if l < bottom && !wrapped {
            if !same_pen(pen, &default) {
                sgr(out, &default, link);
                pen = &default;
            }
            out.extend_from_slice(b"\r\n");
        }
        prev_wrapped = wrapped;
    }
    if !same_pen(pen, &default) {
        sgr(out, &default, link);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grounds(bytes: &[u8]) -> Vec<bool> {
        let mut g = Ground::new();
        bytes.iter().map(|&b| g.step(b)).collect()
    }

    #[test]
    fn ground_after_complete_sequences_only() {
        let s = b"a\x1b[1;31mb";
        let g = grounds(s);
        assert_eq!(
            g,
            [true, false, false, false, false, false, false, true, true]
        );
        assert!(!*grounds(b"\x1b]0;title").last().unwrap());
        assert!(*grounds(b"\x1b]0;title\x07").last().unwrap());
        assert!(*grounds(b"\x1b]0;title\x1b\\").last().unwrap());
        assert!(!*grounds("é".as_bytes()).first().unwrap());
        assert!(*grounds("é".as_bytes()).last().unwrap());
        assert!(!*grounds(b"\x1bP1$qm").last().unwrap());
        assert!(*grounds(b"\x1bP1$qm\x1b\\").last().unwrap());
        assert!(*grounds(b"\x1b[?2026h").last().unwrap());
    }

    #[test]
    fn the_fast_path_finds_the_same_ground_points() {
        let s = "plain \x1b[1mbold é 日本 \x1b]0;t\x07 tail \x1b[3".as_bytes();
        for cut in 0..=s.len() {
            let (mut a, mut b) = (Ground::new(), Ground::new());
            let slow = s[..cut]
                .iter()
                .enumerate()
                .filter(|&(_, &x)| a.step(x))
                .map(|(i, _)| i + 1)
                .last();
            assert_eq!(b.last_ground(&s[..cut]), slow, "cut {cut}");
            assert_eq!(a.st, b.st, "cut {cut}");
        }
    }

    #[test]
    fn decstbm_is_recorded_but_private_r_is_not() {
        let mut g = Ground::new();
        for &b in b"\x1b[5;20r\x1b[?7r" {
            g.step(b);
        }
        assert_eq!(g.region, Some((5, 20)));
        for &b in b"\x1b[9;3r" {
            g.step(b);
        }
        assert_eq!(g.region, Some((5, 20)), "an invalid region is ignored");
        for &b in b"\x1bc" {
            g.step(b);
        }
        assert_eq!(g.region, None, "RIS resets it");
    }

    #[test]
    fn synchronized_output_is_tracked_and_carried() {
        let mut g = Ground::new();
        for &b in b"\x1b[?2026h" {
            g.step(b);
        }
        assert!(g.sync);
        for &b in b"\x1b[?2026l\x1b[2026h" {
            g.step(b);
        }
        assert!(
            !g.sync,
            "?2026l ends it; a non-private 2026h is not the mode"
        );
        let mut s = Screen::new(20, 5, 10);
        s.feed(b"\x1b[?2026hframe");
        let mut p = Vec::new();
        s.picture(&mut p);
        assert!(p.ends_with(b"\x1b[?2026h"));
    }

    #[test]
    fn a_split_sequence_is_held_until_it_completes() {
        let mut s = Screen::new(20, 5, 100);
        s.feed(b"ab\x1b[3");
        assert_eq!(s.fed_seq(), 2);
        s.feed(b"1mc");
        assert_eq!(s.fed_seq(), 8);
        assert!(s.at_ground());
    }

    /// Every cell, the history length, cursor and modes, as comparable text.
    fn state(s: &Screen) -> Vec<String> {
        let g = s.term.grid();
        let mut v = vec![format!(
            "history {} cursor {:?} wrap {} mode {:?} region {:?} sync {}",
            g.history_size(),
            g.cursor.point,
            g.cursor.input_needs_wrap,
            *s.term.mode() - TermMode::URGENCY_HINTS,
            s.region(),
            s.ground.sync
        )];
        for l in -(g.history_size() as i32)..g.screen_lines() as i32 {
            for c in 0..g.columns() {
                let cell = &g[Line(l)][Column(c)];
                let ch = if cell.c == '\0' { ' ' } else { cell.c };
                // Invisible, so not carried by a picture: a blank's foreground,
                // bold, dim and italic; WRAPLINE anywhere but the last column
                // (alacritty's ICH/DCH move it along with the cell).
                let mut flags = cell.flags;
                let mut fg = cell.fg;
                // (and on the bottom row, whose continuation scrolled away)
                if c + 1 < g.columns() || l + 1 == g.screen_lines() as i32 {
                    flags -= Flags::WRAPLINE;
                }
                // a wrapped-wide-char placeholder, or a spacer whose wide
                // character is gone, looks like a blank
                let orphan = c == 0 || !g[Line(l)][Column(c - 1)].flags.contains(Flags::WIDE_CHAR);
                flags -= Flags::LEADING_WIDE_CHAR_SPACER;
                if orphan {
                    flags -= Flags::WIDE_CHAR_SPACER;
                }
                let mut ch = ch;
                if cell.flags.contains(Flags::WIDE_CHAR)
                    && !(c + 1 < g.columns()
                        && g[Line(l)][Column(c + 1)]
                            .flags
                            .contains(Flags::WIDE_CHAR_SPACER))
                {
                    // unprintable: a wide character without its spacer (see write_grid)
                    ch = ' ';
                    flags -= Flags::WIDE_CHAR;
                }
                if ch == ' ' && cell.zerowidth().is_none() {
                    fg = Color::Named(NamedColor::Foreground);
                    flags -= Flags::BOLD | Flags::DIM | Flags::ITALIC;
                }
                v.push(format!(
                    "{l}:{c} {ch:?} {:?} {:?} {:?} {:?} {:?}",
                    fg,
                    cell.bg,
                    flags,
                    cell.zerowidth(),
                    cell.underline_color()
                ));
            }
        }
        v
    }

    /// Feed `stream`, take a picture, replay it into a fresh screen of the
    /// same size: both must hold the same cells, history, cursor and modes.
    fn round_trip(stream: &[u8], cols: u16, rows: u16, sb: usize, chunk: usize) {
        let mut a = Screen::new(cols, rows, sb);
        for c in stream.chunks(chunk) {
            a.feed(c);
        }
        let mut pic = Vec::new();
        a.picture(&mut pic);
        let mut b = Screen::new(cols, rows, sb);
        b.feed(&pic);
        let (sa, sb_) = (state(&a), state(&b));
        let diffs: Vec<_> = sa
            .iter()
            .zip(&sb_)
            .filter(|(x, y)| x != y)
            .take(8)
            .collect();
        assert!(
            sa.len() == sb_.len() && diffs.is_empty(),
            "{} vs {} lines; first diffs {diffs:#?}",
            sa.len(),
            sb_.len()
        );
    }

    /// Deterministic pseudo-random escapes: colours (16/256/rgb), attributes,
    /// cursor jumps, erases, wide and combining characters, scrolling, wraps.
    pub(super) fn noise(seed: u64, n: usize) -> Vec<u8> {
        let mut x = seed;
        let mut r = move |m: u64| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x % m
        };
        let words = [
            "the ",
            "quick ",
            "日本語 ",
            "é ",
            "e\u{301} ",
            "✓ ",
            "★ ",
            "brown fox jumps over ",
        ];
        let mut out = String::new();
        while out.len() < n {
            match r(20) {
                0 => out += &format!("\x1b[38;5;{}m", r(256)),
                1 => out += &format!("\x1b[48;2;{};{};{}m", r(256), r(256), r(256)),
                2 => {
                    out += &format!(
                        "\x1b[{}m",
                        [0, 1, 2, 3, 4, 7, 9, 22, 24, 27, 31, 42, 95, 104][r(14) as usize]
                    )
                }
                3 => out += &format!("\x1b[{};{}H", r(30), r(90)),
                4 => {
                    out += [
                        "\x1b[K", "\x1b[1K", "\x1b[2K", "\x1b[J", "\x1b[3X", "\x1b[2P", "\x1b[2@",
                    ][r(7) as usize]
                }
                5 => out += "\r\n",
                6 => out += ["\x1b[2L", "\x1b[1M", "\x1bM", "\x1b[S", "\x1b[T"][r(5) as usize],
                _ => out += words[r(words.len() as u64) as usize],
            }
        }
        out.into_bytes()
    }

    #[test]
    fn a_picture_round_trips_through_a_fresh_screen() {
        for seed in 1..=20 {
            round_trip(&noise(seed, 200_000), 90, 30, 200, 4095);
        }
    }

    /// "picture @ seq, then the stream from seq" equals the whole stream, for
    /// pictures taken between reads of random length (many end mid-sequence,
    /// so the feed holds bytes back and `seq` trails the ring).
    fn picture_then_rest(stream: &[u8], cols: u16, rows: u16, sb: usize, seed: u64) -> usize {
        let mut x = seed;
        let mut next = move |m: u64| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x % m
        };
        let mut direct = Screen::new(cols, rows, sb);
        let mut pictures = Vec::new();
        let (mut at, mut held) = (0, 0);
        while at < stream.len() {
            let n = (1 + next((stream.len() as u64 / 60).max(64)) as usize).min(stream.len() - at);
            direct.feed(&stream[at..at + n]);
            at += n;
            if next(4) == 0 {
                let mut pic = Vec::new();
                direct.picture(&mut pic);
                held += (direct.fed_seq() as usize != at) as usize;
                pictures.push((at, pic));
            }
        }
        let want = state(&direct);
        for (seq, pic) in &pictures {
            let mut replay = Screen::new(cols, rows, sb);
            replay.feed(pic);
            replay.feed(&stream[*seq..]);
            let got = state(&replay);
            let diffs: Vec<_> = want
                .iter()
                .zip(&got)
                .filter(|(a, b)| a != b)
                .take(6)
                .collect();
            assert!(
                diffs.is_empty() && want.len() == got.len(),
                "picture @ {seq}: {diffs:#?}"
            );
        }
        assert!(pictures.len() > 10);
        held
    }

    #[test]
    fn picture_at_seq_then_the_rest_equals_the_direct_feed() {
        let mut held = 0;
        for seed in 1..=5 {
            held += picture_then_rest(&noise(seed, 150_000), 90, 30, 200, seed);
        }
        assert!(held > 0, "no picture was taken with bytes held back");
        // OSC and DCS strings split across reads, titles, sync output, alt screen
        let mut s = Vec::new();
        for i in 0..400 {
            s.extend_from_slice(
                format!(
                    "\x1b]2;title {i}\x07\x1b[?2026hline {i} \x1bP1$q\"m\x1b\\é日\x1b[?2026l\r\n"
                )
                .as_bytes(),
            );
            if i % 97 == 0 {
                s.extend_from_slice(b"\x1b[?1049h\x1b[5;20rin alt\x1b[?1049l");
            }
        }
        picture_then_rest(&s, 60, 20, 100, 7);
    }

    /// The held bytes of an unfinished sequence travel at the end of the
    /// picture: it stands for everything fed, so the rest of the stream
    /// continues it (POD-4909: the host sends it at the ring's high seq).
    #[test]
    fn a_picture_carries_the_held_bytes_of_an_unfinished_sequence() {
        let mut direct = Screen::new(20, 5, 100);
        direct.feed(b"ab\x1b[3");
        let mut pic = Vec::new();
        direct.picture(&mut pic);
        assert!(
            pic.ends_with(b"\x1b[3"),
            "{:?}",
            String::from_utf8_lossy(&pic)
        );
        let mut replay = Screen::new(20, 5, 100);
        replay.feed(&pic);
        replay.feed(b"1mc");
        direct.feed(b"1mc");
        assert_eq!(state(&replay), state(&direct));
    }

    /// A character split across two reads, then an ASCII byte and the start
    /// of another multibyte character: vte 0.15.0 drops the ASCII byte when it
    /// completes a character it was handed in part (`advance_partial_utf8`
    /// returns `valid_bytes - old_bytes`), so the feed never hands it one.
    #[test]
    fn a_character_split_across_reads_keeps_the_byte_after_it() {
        let stream = "é ✓ done".as_bytes();
        let mut whole = Screen::new(20, 3, 10);
        whole.feed(stream);
        for cut in 1..stream.len() {
            let mut split = Screen::new(20, 3, 10);
            split.feed(&stream[..cut]);
            split.feed(&stream[cut..]);
            assert_eq!(state(&split), state(&whole), "split after byte {cut}");
        }
    }

    /// The primary screen's pen survives a picture taken while the
    /// alternate screen is up: leaving it, the program writes with that pen.
    #[test]
    fn a_picture_under_the_alternate_screen_keeps_the_primary_pen() {
        let before = b"main \x1b[1;3;38;5;169m\x1b[?1049h\x1b[0;32malt text";
        let after = b"\x1b[?1049lpen";
        let mut direct = Screen::new(30, 5, 10);
        direct.feed(before);
        let mut pic = Vec::new();
        direct.picture(&mut pic);
        let mut replay = Screen::new(30, 5, 10);
        replay.feed(&pic);
        replay.feed(after);
        direct.feed(after);
        assert_eq!(state(&replay), state(&direct));
    }

    /// Dense colour, one RGB background per cell.
    fn dense(cols: usize, lines: usize) -> Vec<u8> {
        let mut out = String::new();
        for l in 0..lines {
            for c in 0..cols {
                let v = (l * 7 + c * 13) % 251;
                out += &format!(
                    "\x1b[48;2;{v};{};{}m{}",
                    (v * 3) % 256,
                    (v * 5) % 256,
                    (b'a' + (c % 26) as u8) as char
                );
            }
            out += "\x1b[0m\r\n";
        }
        out.into_bytes()
    }

    /// Everything but the history: the header without its length, and the
    /// cells of the visible lines.
    fn visible(s: &Screen) -> Vec<String> {
        let mut v = state(s);
        v[0] = v[0].split_once(" cursor").unwrap().1.to_string();
        v.retain(|l| !l.starts_with('-'));
        v
    }

    /// A picture over the 1 MiB budget drops scrollback lines from the top
    /// until it fits; the visible screen stays exact.
    #[test]
    fn a_picture_over_the_budget_trims_scrollback_and_keeps_the_screen() {
        let mut a = Screen::new(200, 30, 1000);
        for c in dense(200, 1100).chunks(4096) {
            a.feed(c);
        }
        let mut pic = Vec::new();
        a.picture(&mut pic);
        assert!(pic.len() <= 1 << 20, "picture of {} bytes", pic.len());
        let mut b = Screen::new(200, 30, 1000);
        b.feed(&pic);
        let kept = b.term.grid().history_size();
        assert!(
            kept > 0 && kept < a.term.grid().history_size(),
            "kept {kept} lines"
        );
        assert_eq!(visible(&b), visible(&a));
    }

    /// A visible screen larger than the budget is sent whole (the queue
    /// limit's exclusion is the real bound), and still exact.
    #[test]
    fn a_visible_screen_over_the_budget_is_sent_whole() {
        let stream = dense(1000, 120);
        let mut a = Screen::new(1000, 100, 0);
        a.feed(&stream);
        let mut pic = Vec::new();
        a.picture(&mut pic);
        assert!(pic.len() > 1 << 20, "picture of {} bytes", pic.len());
        round_trip(&stream, 1000, 100, 0, 65536);
    }

    fn count(hay: &[u8], needle: &[u8]) -> usize {
        hay.windows(needle.len()).filter(|w| *w == needle).count()
    }

    /// OSC 8 is written only where the link changes, not with every pen.
    #[test]
    fn a_hyperlink_is_written_only_where_it_changes() {
        let mut s = Screen::new(40, 6, 100);
        s.feed(b"plain \x1b[31mred \x1b[1mbold\x1b[0m\r\n\x1b[32mgreen\x1b[0m\r\n");
        let mut p = Vec::new();
        s.picture(&mut p);
        assert_eq!(
            count(&p, b"\x1b]8;"),
            0,
            "{:?}",
            String::from_utf8_lossy(&p)
        );

        let stream = b"see \x1b]8;id=x;http://a/\x1b\\li\x1b[1mnk\x1b[31m!\x1b]8;;\x1b\\ done \x1b[4mu\x1b[0m\r\nnext";
        let mut s = Screen::new(40, 6, 100);
        s.feed(stream);
        let mut p = Vec::new();
        s.picture(&mut p);
        assert_eq!(
            count(&p, b"\x1b]8;"),
            2,
            "one open, one close: {:?}",
            String::from_utf8_lossy(&p)
        );
        let mut r = Screen::new(40, 6, 100);
        r.feed(&p);
        let mut q = Vec::new();
        r.picture(&mut q);
        assert_eq!(q, p, "the link round-trips");
    }

    /// `PODIUM_SCREEN_STREAM=<file> cargo test --features screen -- --ignored`
    #[test]
    #[ignore]
    fn a_recorded_stream_splices_at_every_picture() {
        let path = std::env::var("PODIUM_SCREEN_STREAM").expect("PODIUM_SCREEN_STREAM");
        let data = std::fs::read(path).unwrap();
        picture_then_rest(&data, 160, 45, 1000, 11);
    }

    #[test]
    fn a_picture_round_trips_modes_region_and_the_alternate_screen() {
        let s =
            b"primary line\r\n\x1b[1;33mmore\x1b[0m\x1b[?2004h\x1b[?1000h\x1b[?1006h\x1b[?1h\x1b=\
                  \x1b[?1049h\x1b[2;20r\x1b[5;3Halt text\x1b[?25l\x1b[4 q\x1b]2;my title\x07";
        round_trip(s, 40, 24, 100, 7);
        round_trip(&[&noise(9, 20_000)[..], &s[..]].concat(), 40, 24, 100, 4095);
    }

    /// `PODIUM_SCREEN_STREAM=<file> cargo test --features screen -- --ignored`
    #[test]
    #[ignore]
    fn a_recorded_stream_round_trips() {
        let path = std::env::var("PODIUM_SCREEN_STREAM").expect("PODIUM_SCREEN_STREAM");
        let data = std::fs::read(path).unwrap();
        round_trip(&data, 160, 45, 1000, 4095);
    }

    #[test]
    fn picture_redraws_text_and_modes() {
        let mut s = Screen::new(20, 5, 100);
        s.feed(b"\x1b[?2004h\x1b[?1hhello\r\n\x1b[1;32mworld\x1b[0m");
        let mut p = Vec::new();
        s.picture(&mut p);
        let p = String::from_utf8(p).unwrap();
        assert!(p.starts_with("\x1bc"));
        assert!(p.contains("hello"));
        assert!(p.contains("\x1b[0;1;32m"));
        assert!(p.contains("\x1b[?2004h"));
        assert!(p.contains("\x1b[?1h"));
        assert!(p.contains("\x1b[2;6H"));
    }
}

#[cfg(test)]
mod security_regressions {
    use super::*;

    #[test]
    fn stored_title_and_hyperlink_are_bounded_when_serialized() {
        let mut s = Screen::new(80, 24, 0);
        *s.title.borrow_mut() = Some("B".repeat(2_000_000));
        s.term.grid_mut()[Line(0)][Column(0)].c = 'X';
        s.term.grid_mut()[Line(0)][Column(0)].set_hyperlink(Some(Hyperlink::new(
            Some("id"), format!("http://x/{}", "U".repeat(1_500_000)),
        )));
        let mut p = Vec::new();
        s.picture(&mut p);
        assert!(p.iter().filter(|&&b| b == b'B').count() <= 4096);
        assert!(p.iter().filter(|&&b| b == b'U').count() <= 4096);
    }

    #[test]
    fn visible_screen_exception_has_an_absolute_picture_ceiling() {
        let mut s = Screen::new(1000, 500, 0);
        let grid = s.term.grid_mut();
        for l in 0..500 {
            for c in 0..1000 {
                let cell = &mut grid[Line(l)][Column(c)];
                cell.c = 'X';
                for _ in 0..16 { cell.push_zerowidth('\u{301}'); }
            }
        }
        let mut p = b"prefix".to_vec();
        assert!(s.picture(&mut p), "unrepresentable pictures must be marked truncated");
        assert_eq!(p, b"prefix", "no partial picture may be emitted past the 8 MiB ceiling");
    }

    #[test]
    fn long_control_strings_do_not_feed_unbounded_payloads_or_grow_the_hold() {
        for start in [b"\x1b]0;".as_slice(), b"\x1bP1$q", b"\x1b_", b"\x1b^", b"\x1bX"] {
            let mut s = Screen::new(80, 24, 0);
            s.feed(start);
            s.feed(&vec![b'A'; HOLD_MAX * 4]);
            assert!(s.held.len() <= HOLD_MAX);
            // An overflow cannot reintroduce attacker-controlled bytes into a picture.
            s.feed(b"\x1b\\safe");
            let mut p = Vec::new();
            s.picture(&mut p);
            assert!(!p.windows(100).any(|b| b.iter().all(|&x| x == b'A')));
            assert!(p.windows(4).any(|b| b == b"safe"));
        }
    }
}
