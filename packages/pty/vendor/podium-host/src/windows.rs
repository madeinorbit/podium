//! Windows OS boundary for the shared SPEC-6 host loop.
//!
//! Every parent-side pipe is overlapped; ConPTY receives synchronous ends.
//! Pending operations own their buffers and OVERLAPPED until completion/cancel.
//! No client, input writer or ConPTY shutdown can block the protocol loop.
use std::cell::RefCell;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{self, Read, Write};
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Security::Authorization::*;
use windows_sys::Win32::Security::*;
use windows_sys::Win32::Storage::FileSystem::*;
use windows_sys::Win32::System::Console::*;
use windows_sys::Win32::System::IO::*;
use windows_sys::Win32::System::JobObjects::*;

use windows_sys::Win32::System::Pipes::*;
use windows_sys::Win32::System::Threading::*;

use crate::args::{Command, CreateOpts};
use crate::host::{Child, ChildIo, Host};
use crate::ring::Ring;

pub type Io = Stream;
pub type SignalSource = ();
pub const SIGTERM: i32 = 15;
pub const SIGKILL: i32 = 9;
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Pid(u32);
impl Pid {
    pub fn as_raw_nonzero(self) -> std::num::NonZeroU32 {
        std::num::NonZeroU32::new(self.0).unwrap()
    }
}
#[derive(Clone, Copy)]
pub struct Winsize {
    pub ws_col: u16,
    pub ws_row: u16,
}
bitflags::bitflags! {
    #[derive(Clone, Copy)]
    pub struct PollFlags: u8 { const IN=1; const OUT=2; const HUP=4; const ERR=8; const NVAL=16; }
}
pub fn strerror(e: &io::Error) -> String {
    e.to_string()
}
pub fn got_term() -> bool {
    false
}
pub fn peer_is_us(_: &Stream) -> bool {
    true
} // enforced by the listener's protected DACL

fn wide(s: impl AsRef<OsStr>) -> Vec<u16> {
    s.as_ref().encode_wide().chain(Some(0)).collect()
}
fn check(ok: windows_sys::core::BOOL) -> io::Result<()> {
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
fn blocked() -> io::Error {
    io::ErrorKind::WouldBlock.into()
}

struct Handle(HANDLE);
// Ownership is exclusive, and Windows handles can move across threads.
unsafe impl Send for Handle {}
impl Handle {
    fn new(h: HANDLE) -> io::Result<Self> {
        if h == INVALID_HANDLE_VALUE || h.is_null() {
            Err(io::Error::last_os_error())
        } else {
            Ok(Self(h))
        }
    }
}
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

/// A pending operation's pointers never move. Drop cancels and waits BEFORE
/// freeing the buffer/OVERLAPPED, even if a client disconnects mid-write.
struct Operation {
    ov: Box<OVERLAPPED>,
    buffer: Vec<u8>,
    pending: bool,
    event: Handle,
}
impl Operation {
    fn new() -> io::Result<Self> {
        let event = Handle::new(unsafe { CreateEventW(null(), 1, 0, null()) })?;
        let mut ov: Box<OVERLAPPED> = Box::new(unsafe { zeroed() });
        ov.hEvent = event.0;
        Ok(Self {
            ov,
            buffer: Vec::new(),
            pending: false,
            event,
        })
    }
    fn prepare(&mut self, buffer: Vec<u8>) {
        self.buffer = buffer;
        unsafe {
            ResetEvent(self.event.0);
        }
        *self.ov = unsafe { zeroed() };
        self.ov.hEvent = self.event.0;
    }
    fn result(&mut self, handle: HANDLE) -> io::Result<usize> {
        let mut n = 0;
        if unsafe { GetOverlappedResult(handle, &*self.ov, &mut n, 0) } != 0 {
            self.pending = false;
            return Ok(n as usize);
        }
        let err = io::Error::last_os_error();
        if err.raw_os_error() == Some(ERROR_IO_INCOMPLETE as i32) {
            return Err(blocked());
        }
        self.pending = false;
        Err(err)
    }
    fn cancel(&mut self, handle: HANDLE) {
        if self.pending {
            unsafe {
                CancelIoEx(handle, &*self.ov);
                let mut n = 0;
                GetOverlappedResult(handle, &*self.ov, &mut n, 1);
            }
            self.pending = false;
        }
    }
}

pub struct Stream {
    handle: Handle,
    read: RefCell<Operation>,
    write: RefCell<Operation>,
}
impl Stream {
    fn new(handle: Handle) -> io::Result<Self> {
        Ok(Self {
            handle,
            read: RefCell::new(Operation::new()?),
            write: RefCell::new(Operation::new()?),
        })
    }
    pub fn set_nonblocking(&self, _: bool) -> io::Result<()> {
        Ok(())
    }
    pub fn events(&self) -> PollFlags {
        let mut flags = PollFlags::OUT;
        let mut available = 0;
        if unsafe {
            PeekNamedPipe(
                self.handle.0,
                null_mut(),
                0,
                null_mut(),
                &mut available,
                null_mut(),
            )
        } == 0
        {
            return flags | PollFlags::HUP;
        }
        if available > 0 || self.read.borrow().pending {
            flags |= PollFlags::IN;
        }
        flags
    }
}
impl Drop for Stream {
    fn drop(&mut self) {
        self.read.get_mut().cancel(self.handle.0);
        self.write.get_mut().cancel(self.handle.0);
    }
}
impl Read for &Stream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let mut op = self.read.borrow_mut();
        if !op.pending {
            // Avoid posting a read with no data; this also observes EOF.
            let mut available = 0;
            if unsafe {
                PeekNamedPipe(
                    self.handle.0,
                    null_mut(),
                    0,
                    null_mut(),
                    &mut available,
                    null_mut(),
                )
            } == 0
            {
                let err = io::Error::last_os_error();
                if err.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) {
                    return Ok(0);
                }
                return Err(err);
            }
            if available == 0 {
                return Err(blocked());
            }
            op.prepare(vec![0; buf.len().min(available as usize)]);
            op.pending = true;
            let ok = unsafe {
                ReadFile(
                    self.handle.0,
                    op.buffer.as_mut_ptr(),
                    op.buffer.len() as u32,
                    null_mut(),
                    &mut *op.ov,
                )
            };
            if ok == 0 {
                let err = io::Error::last_os_error();
                if err.raw_os_error() != Some(ERROR_IO_PENDING as i32) {
                    op.pending = false;
                    return Err(err);
                }
            }
            // Even immediate overlapped completions obtain their byte count
            // from GetOverlappedResult, never the synchronous count argument.
        }
        let n = op.result(self.handle.0)?;
        buf[..n].copy_from_slice(&op.buffer[..n]);
        Ok(n)
    }
}
impl Write for &Stream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let mut op = self.write.borrow_mut();
        if !op.pending {
            if buf.is_empty() {
                return Ok(0);
            }
            op.prepare(buf[..buf.len().min(65536)].to_vec());
            op.pending = true;
            let ok = unsafe {
                WriteFile(
                    self.handle.0,
                    op.buffer.as_ptr(),
                    op.buffer.len() as u32,
                    null_mut(),
                    &mut *op.ov,
                )
            };
            if ok == 0 {
                let err = io::Error::last_os_error();
                if err.raw_os_error() != Some(ERROR_IO_PENDING as i32) {
                    op.pending = false;
                    return Err(err);
                }
            }
        }
        op.result(self.handle.0)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Protected ACL granting only the token user access. No Everyone, network,
/// administrator-group or inherited ACE. Reject remote clients independently.
struct Security {
    descriptor: PSECURITY_DESCRIPTOR,
}
impl Security {
    fn current_user() -> io::Result<Self> {
        let mut token = null_mut();
        check(unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) })?;
        let token = Handle::new(token)?;
        let mut len = 0;
        unsafe {
            GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut len);
        }
        let mut storage = vec![0usize; (len as usize).div_ceil(size_of::<usize>())];
        check(unsafe {
            GetTokenInformation(
                token.0,
                TokenUser,
                storage.as_mut_ptr().cast(),
                len,
                &mut len,
            )
        })?;
        let user = unsafe { &*(storage.as_ptr().cast::<TOKEN_USER>()) };
        let mut sid = null_mut();
        check(unsafe { ConvertSidToStringSidW(user.User.Sid, &mut sid) })?;
        let mut count = 0;
        unsafe {
            while *sid.add(count) != 0 {
                count += 1;
            }
        }
        let sid_text = unsafe { String::from_utf16_lossy(std::slice::from_raw_parts(sid, count)) };
        unsafe {
            LocalFree(sid.cast());
        }
        let sddl = wide(format!("O:{sid_text}D:P(A;;GA;;;{sid_text})"));
        let mut descriptor = null_mut();
        check(unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                null_mut(),
            )
        })?;
        Ok(Self { descriptor })
    }
    fn attributes(&self, inherit: bool) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.descriptor,
            bInheritHandle: inherit as i32,
        }
    }
}
impl Drop for Security {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.descriptor);
        }
    }
}

struct Listening {
    handle: Handle,
    connect: Operation,
    connected: bool,
}
pub struct Listener {
    name: Vec<u16>,
    security: Security,
    waiting: RefCell<Listening>,
}
impl Listener {
    fn instance(name: &[u16], security: &Security, first: bool) -> io::Result<Listening> {
        let sa = security.attributes(false);
        let flags = PIPE_ACCESS_DUPLEX
            | FILE_FLAG_OVERLAPPED
            | if first {
                FILE_FLAG_FIRST_PIPE_INSTANCE
            } else {
                0
            };
        let handle = Handle::new(unsafe {
            CreateNamedPipeW(
                name.as_ptr(),
                flags,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                65,
                65536,
                65536,
                0,
                &sa,
            )
        }).map_err(|e| {
            if first && e.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32) {
                // Only failure of FIRST_PIPE_INSTANCE establishes a name collision.
                io::Error::new(io::ErrorKind::AddrInUse, e)
            } else { e }
        })?;
        let mut connect = Operation::new()?;
        let ok = unsafe { ConnectNamedPipe(handle.0, &mut *connect.ov) };
        let connected = if ok != 0 {
            true
        } else {
            match unsafe { GetLastError() } {
                ERROR_PIPE_CONNECTED => true,
                ERROR_IO_PENDING => {
                    connect.pending = true;
                    false
                }
                _ => return Err(io::Error::last_os_error()),
            }
        };
        Ok(Listening {
            handle,
            connect,
            connected,
        })
    }
    fn bind(name: &OsStr) -> io::Result<Self> {
        if !name.to_string_lossy().starts_with(r"\\.\pipe\podium-host-") {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "expected a local podium-host named pipe",
            ));
        }
        let name = wide(name);
        let security = Security::current_user()?;
        let waiting = RefCell::new(Self::instance(&name, &security, true)?);
        Ok(Self {
            name,
            security,
            waiting,
        })
    }
    pub fn ready(&self) -> bool {
        let mut w = self.waiting.borrow_mut();
        if w.connected {
            return true;
        }
        let handle = w.handle.0;
        if w.connect.result(handle).is_ok() {
            w.connected = true;
        }
        w.connected
    }
    pub fn accept(&self) -> io::Result<(Stream, ())> {
        if !self.ready() {
            return Err(blocked());
        }
        // Keep an instance alive continuously so the name cannot be hijacked.
        let next = Self::instance(&self.name, &self.security, false)?;
        let old = self.waiting.replace(next);
        Ok((Stream::new(old.handle)?, ()))
    }
}
impl Drop for Listener {
    fn drop(&mut self) {
        let w = self.waiting.get_mut();
        w.connect.cancel(w.handle.0);
    }
}

/// Overlapped host end + synchronous child/ConPTY end, also restricted to this
/// user. FIRST_PIPE_INSTANCE and unpredictable names prevent a local squatter.
fn io_pair(input: bool, security: &Security) -> io::Result<(Stream, Handle)> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let name = wide(format!(
        r"\\.\pipe\podium-host-io-{}-{}-{id}",
        std::process::id(),
        random_suffix()?
    ));
    let sa = security.attributes(false);
    let host = Handle::new(unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            (if input {
                PIPE_ACCESS_OUTBOUND
            } else {
                PIPE_ACCESS_INBOUND
            }) | FILE_FLAG_OVERLAPPED
                | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            65536,
            65536,
            0,
            &sa,
        )
    })?;
    let child = Handle::new(unsafe {
        CreateFileW(
            name.as_ptr(),
            if input { GENERIC_READ } else { GENERIC_WRITE },
            0,
            null(),
            OPEN_EXISTING,
            0,
            null_mut(),
        )
    })?;
    // Complete the server-side connection even when CreateFile won the race.
    let mut connection = Operation::new()?;
    if unsafe { ConnectNamedPipe(host.0, &mut *connection.ov) } == 0
        && unsafe { GetLastError() } != ERROR_PIPE_CONNECTED
    {
        return Err(io::Error::last_os_error());
    }
    Ok((Stream::new(host)?, child))
}
fn random_suffix() -> io::Result<String> {
    // std uses the OS CSPRNG for RandomState; two independent keyed hashes give
    // a name that cannot be guessed before the protected pipe is created.
    use std::hash::{BuildHasher, Hasher};
    let a = std::collections::hash_map::RandomState::new()
        .build_hasher()
        .finish();
    let b = std::collections::hash_map::RandomState::new()
        .build_hasher()
        .finish();
    Ok(format!("{a:016x}{b:016x}"))
}

fn termination_status(signo: i32) -> Option<u32> {
    matches!(signo, 2 | 9 | 15).then_some((128 + signo) as u32)
}

pub struct ChildControl {
    process: Handle,
    job: Handle,
    console: RefCell<Option<HPCON>>,
}
impl ChildControl {
    pub fn resize(&self, ws: Winsize) -> bool {
        if ws.ws_col == 0
            || ws.ws_row == 0
            || ws.ws_col > i16::MAX as u16
            || ws.ws_row > i16::MAX as u16
        {
            return false;
        }
        self.console.borrow().is_some_and(|pc| unsafe { ResizePseudoConsole(pc, COORD { X: ws.ws_col as i16, Y: ws.ws_row as i16 }) } >= 0)
    }
    pub fn exit_code(&self) -> Option<i32> {
        if unsafe { WaitForSingleObject(self.process.0, 0) } != WAIT_OBJECT_0 {
            return None;
        }
        let mut code = 0;
        (unsafe { GetExitCodeProcess(self.process.0, &mut code) } != 0).then_some(code as i32)
    }
    pub fn signal(&self, signo: i32) {
        // ConPTY SIGINT is queued input by the host. A --no-pty child has
        // CREATE_NO_WINDOW and no console to receive a console control event:
        // its interrupt equivalent terminates the owned job with status 130.
        // It must not silently defeat SDK interrupt/termination escalation.
        if let Some(code) = termination_status(signo) {
            unsafe { TerminateJobObject(self.job.0, code); }
        }
    }
    pub fn close_console(&self) {
        if let Some(pc) = self.console.borrow_mut().take() {
            // ClosePseudoConsole may wait for final output to drain. Keep the
            // main loop reading until EOF, never close it on the loop thread.
            std::thread::spawn(move || unsafe {
                ClosePseudoConsole(pc);
            });
        }
        // Descendants must not keep --no-pty stdout alive after root exit.
        unsafe {
            TerminateJobObject(self.job.0, 0);
        }
    }
}
impl Drop for ChildControl {
    fn drop(&mut self) {
        self.close_console();
    }
}

struct Attributes {
    _storage: Vec<usize>,
    ptr: LPPROC_THREAD_ATTRIBUTE_LIST,
}
impl Attributes {
    fn new() -> io::Result<Self> {
        let mut bytes = 0;
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut bytes);
        }
        let mut storage = vec![0usize; bytes.div_ceil(size_of::<usize>())];
        let ptr = storage.as_mut_ptr().cast();
        check(unsafe { InitializeProcThreadAttributeList(ptr, 1, 0, &mut bytes) })?;
        Ok(Self {
            _storage: storage,
            ptr,
        })
    }
    fn set(&self, key: usize, value: *const std::ffi::c_void, len: usize) -> io::Result<()> {
        check(unsafe {
            UpdateProcThreadAttribute(self.ptr, 0, key, value, len, null_mut(), null_mut())
        })
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe {
            DeleteProcThreadAttributeList(self.ptr);
        }
    }
}

/// Standard Windows argv quoting, including embedded quotes and trailing
/// backslashes. CreateProcess sees exactly the command/args the caller sent.
fn quote_arg(arg: &str) -> String {
    // cmd.exe and PowerShell also inspect the native command line for their
    // switches. Leave simple arguments bare, as Windows' own launchers do.
    if !arg.is_empty() && !arg.chars().any(|c| c.is_whitespace() || c == '"') {
        return arg.to_owned();
    }
    let mut out = String::from("\"");
    let mut slashes = 0;
    for ch in arg.chars() {
        if ch == '\\' {
            slashes += 1;
            continue;
        }
        if ch == '"' {
            out.extend(std::iter::repeat_n('\\', slashes * 2 + 1));
        } else {
            out.extend(std::iter::repeat_n('\\', slashes));
        }
        slashes = 0;
        out.push(ch);
    }
    out.extend(std::iter::repeat_n('\\', slashes * 2));
    out.push('"');
    out
}
/// Batch shims add a CMD parsing layer. Quote metacharacters, disable delayed
/// expansion and prevent percent-variable expansion (as std::process does).
fn quote_batch_arg(arg: &str) -> io::Result<String> {
    if arg.contains(['\r', '\n']) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "batch arguments cannot contain newlines; use a native executable",
        ));
    }
    let mut out = String::from("\"");
    let mut slashes = 0;
    for ch in arg.chars() {
        if ch == '\\' {
            slashes += 1;
            out.push(ch);
            continue;
        }
        if ch == '"' {
            out.extend(std::iter::repeat_n('\\', slashes));
            out.push('"');
        }
        if ch == '%' {
            out.push_str("%%cd:~,");
        }
        out.push(ch);
        slashes = 0;
    }
    out.extend(std::iter::repeat_n('\\', slashes));
    out.push('"');
    Ok(out)
}

fn resolve_program(program: &str) -> io::Result<PathBuf> {
    resolve_program_on_path(program,
        &std::env::var_os("PATH").unwrap_or_default(),
        &std::env::var("PATHEXT").unwrap_or(".COM;.EXE;.BAT;.CMD".into()))
}
fn resolve_program_on_path(program: &str, path: &OsStr, extensions: &str) -> io::Result<PathBuf> {
    // CreateProcessW's search omits PATH changes in custom environments in some
    // launchers. Resolve before spawning, and pass an explicit application path.
    let p = Path::new(program);
    if p.is_absolute() || program.contains('\\') || program.contains('/') {
        if p.is_file() {
            return Ok(p.to_path_buf());
        }
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("cannot run {program}"),
        ));
    }
    // Match execvp: a repository must not override a bare agent command.
    // Explicit relative paths remain supported above; only PATH searches here.
    for dir in std::env::split_paths(path) {
        for ext in std::iter::once("").chain(extensions.split(';')) {
            let candidate = dir.join(format!("{program}{ext}"));
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        format!("cannot run {program}"),
    ))
}
fn spawn_child(opts: &CreateOpts) -> io::Result<Child> {
    let security = Security::current_user()?;
    let (input, child_input) = io_pair(true, &security)?;
    let (output, child_output) = io_pair(false, &security)?;
    let attrs = Attributes::new()?;
    let ws = Winsize {
        ws_col: opts.cols,
        ws_row: opts.rows,
    };
    let mut console = 0;
    let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    // The detached host has NUL stdio. Explicit null standard handles let
    // ConPTY populate the child's console handles instead of inheriting NUL.
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.lpAttributeList = attrs.ptr;
    let mut inherited = [child_input.0, child_output.0];
    if !opts.no_pty {
        if ws.ws_col > i16::MAX as u16 || ws.ws_row > i16::MAX as u16 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "ConPTY geometry exceeds 32767",
            ));
        }
        let hr = unsafe {
            CreatePseudoConsole(
                COORD {
                    X: ws.ws_col as i16,
                    Y: ws.ws_row as i16,
                },
                child_input.0,
                child_output.0,
                0,
                &mut console,
            )
        };
        if hr < 0 {
            return Err(io::Error::new(
                io::ErrorKind::Other,
                format!("CreatePseudoConsole: HRESULT {hr:#x}"),
            ));
        }
        attrs.set(
            PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
            console as *const _,
            size_of::<HPCON>(),
        )?;
    } else {
        for h in inherited {
            check(unsafe { SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) })?;
        }
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = child_input.0;
        startup.StartupInfo.hStdOutput = child_output.0;
        startup.StartupInfo.hStdError = child_output.0;
        attrs.set(
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            inherited.as_mut_ptr().cast(),
            size_of_val(&inherited),
        )?;
    }
    let job = Handle::new(unsafe { CreateJobObjectW(null(), null()) })?;
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    check(unsafe {
        SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of_val(&limits) as u32,
        )
    })?;
    let args: Vec<&str> = opts
        .command
        .iter()
        .map(|a| a.to_str().expect("Unicode Windows argv"))
        .collect();
    let program = resolve_program(args[0])?;
    let batch = program
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"));
    let app = if batch {
        PathBuf::from(
            std::env::var_os("COMSPEC").unwrap_or(OsString::from(r"C:\Windows\System32\cmd.exe")),
        )
    } else {
        program.clone()
    };
    let command_line = if batch {
        format!(
            "{} /e:ON /v:OFF /d /s /c \"{}\"",
            quote_arg(&app.to_string_lossy()),
            std::iter::once(program.to_string_lossy().into_owned())
                .chain(args[1..].iter().map(|a| a.to_string()))
                .map(|a| quote_batch_arg(&a))
                .collect::<io::Result<Vec<_>>>()?
                .join(" ")
        )
    } else {
        args.iter()
            .map(|a| quote_arg(a))
            .collect::<Vec<_>>()
            .join(" ")
    };
    let mut command_line = wide(command_line);
    let cwd = opts
        .cwd
        .as_ref()
        .map(|v| wide(std::str::from_utf8(v).unwrap()));
    let mut pi: PROCESS_INFORMATION = unsafe { zeroed() };
    let flags = EXTENDED_STARTUPINFO_PRESENT
        | CREATE_SUSPENDED
        | if opts.no_pty { CREATE_NO_WINDOW } else { 0 };
    let created = unsafe {
        CreateProcessW(
            wide(app).as_ptr(),
            command_line.as_mut_ptr(),
            null(),
            null(),
            opts.no_pty as i32,
            flags,
            null(),
            cwd.as_ref().map_or(null(), |v| v.as_ptr()),
            &startup.StartupInfo,
            &mut pi,
        )
    };
    if created == 0 {
        let err = io::Error::last_os_error();
        if console != 0 {
            std::thread::spawn(move || unsafe {
                ClosePseudoConsole(console);
            });
        }
        return Err(err);
    }
    let process = Handle::new(pi.hProcess)?;
    let thread = Handle::new(pi.hThread)?;
    if let Err(e) = check(unsafe { AssignProcessToJobObject(job.0, process.0) }) {
        unsafe {
            TerminateProcess(process.0, 1);
        }
        return Err(e);
    }
    if unsafe { ResumeThread(thread.0) } == u32::MAX {
        return Err(io::Error::last_os_error());
    }
    drop((thread, child_input, child_output));
    Ok(Child {
        pid: Pid(pi.dwProcessId),
        io: ChildIo {
            output,
            input: Some(input),
        },
        has_pty: !opts.no_pty,
        ws,
        control: ChildControl {
            process,
            job,
            console: RefCell::new((console != 0).then_some(console)),
        },
    })
}

pub fn remove_own_socket(path: &Path, id: Option<(u64, u64)>) {
    if id == Some((std::process::id() as u64, 0))
        && fs::read_to_string(path).ok().as_deref() == Some(&format!("{}\n", std::process::id()))
    {
        let _ = fs::remove_file(path);
    }
}
fn protected_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let security = Security::current_user()?;
    let sa = security.attributes(false);
    let staged = path.with_extension(format!("new-{}", std::process::id()));
    let result = (|| {
        let handle = Handle::new(unsafe {
            CreateFileW(
                wide(&staged).as_ptr(),
                GENERIC_WRITE,
                0,
                &sa,
                CREATE_NEW,
                FILE_ATTRIBUTE_NORMAL,
                null_mut(),
            )
        })?;
        let mut n = 0;
        check(unsafe {
            WriteFile(
                handle.0,
                bytes.as_ptr(),
                bytes.len() as u32,
                &mut n,
                null_mut(),
            )
        })?;
        if n as usize != bytes.len() {
            return Err(io::ErrorKind::WriteZero.into());
        }
        drop(handle);
        // The launcher can never observe an empty/partial startup report.
        fs::rename(&staged, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(staged);
    }
    result
}

/// A client authenticates the server on the very handle that carries input.
/// Node/Bun do not expose the SQOS flags or that HANDLE; never open Windows
/// protocol connections directly through their net API.
fn verify_server(handle: HANDLE, expected_owner: PSID) -> io::Result<()> {
    let mut pid = 0;
    check(unsafe { GetNamedPipeServerProcessId(handle, &mut pid) })?;
    let process = Handle::new(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) })?;
    let mut token = null_mut();
    check(unsafe { OpenProcessToken(process.0, TOKEN_QUERY, &mut token) })?;
    let token = Handle::new(token)?;
    let mut len = 0;
    unsafe { GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut len); }
    let mut storage = vec![0usize; (len as usize).div_ceil(size_of::<usize>())];
    check(unsafe { GetTokenInformation(token.0, TokenUser, storage.as_mut_ptr().cast(), len, &mut len) })?;
    let user = unsafe { &*(storage.as_ptr().cast::<TOKEN_USER>()) };
    if unsafe { EqualSid(expected_owner, user.User.Sid) } == 0 {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "named pipe server belongs to another user"));
    }
    Ok(())
}
fn authenticated_pipe(name: &OsStr) -> io::Result<Stream> {
    if !name.to_string_lossy().starts_with(r"\\.\pipe\podium-host-") {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "expected a local podium-host named pipe"));
    }
    let handle = Handle::new(unsafe {
        CreateFileW(wide(name).as_ptr(), GENERIC_READ | GENERIC_WRITE, 0, null(), OPEN_EXISTING,
            FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, null_mut())
    })?;
    let security = Security::current_user()?;
    let mut owner = null_mut();
    let mut defaulted = 0;
    check(unsafe { GetSecurityDescriptorOwner(security.descriptor, &mut owner, &mut defaulted) })?;
    verify_server(handle.0, owner)?;
    Stream::new(handle)
}
fn connect_stdio(name: &OsStr) -> io::Result<()> {
    let pipe = authenticated_pipe(name)?;
    // This is the only startup notification; stdout is exclusively protocol.
    // No input is read/forwarded and no server bytes are rendered before vetting.
    eprintln!("CONNECTED");
    let (sender, receiver) = std::sync::mpsc::sync_channel(4);
    std::thread::spawn(move || {
        let mut input = io::stdin().lock();
        loop {
            let mut bytes = vec![0; 16384];
            match input.read(&mut bytes) {
                Ok(0) | Err(_) => break,
                Ok(n) => { bytes.truncate(n); if sender.send(bytes).is_err() { break; } }
            }
        }
    });
    let mut pending = Vec::new();
    let mut offset = 0;
    let mut output = io::stdout().lock();
    let mut buffer = [0; 16384];
    loop {
        if pending.is_empty() {
            match receiver.try_recv() {
                Ok(bytes) => { pending = bytes; offset = 0; }
                Err(std::sync::mpsc::TryRecvError::Disconnected) => return Ok(()),
                Err(std::sync::mpsc::TryRecvError::Empty) => (),
            }
        }
        if !pending.is_empty() {
            match (&pipe).write(&pending[offset..]) {
                Ok(0) => return Ok(()),
                Ok(n) => { offset += n; if offset == pending.len() { pending.clear(); } }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => (),
                Err(e) => return Err(e),
            }
        }
        match (&pipe).read(&mut buffer) {
            Ok(0) => return Ok(()),
            Ok(n) => { output.write_all(&buffer[..n])?; output.flush()?; }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => (),
            Err(e) => return Err(e),
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// The public launcher waits for a private ready-file after the detached host
/// has bound the pipe and spawned the child. A failed breakaway is a failure,
/// never a hidden job-bound host that would die with the daemon.
pub fn run() {
    let argv: Vec<Vec<u8>> = std::env::args().map(String::into_bytes).collect();
    let parsed = match crate::args::parse(&argv) {
        Ok(p) => p,
        Err(crate::args::ArgError::Usage) => crate::usage(),
        Err(crate::args::ArgError::Die(msg)) => crate::die_raw(&[&msg]),
    };
    match parsed {
        Command::Version => println!(
            "podium-host {} features={}",
            crate::VERSION,
            crate::HOST_FEATURES
        ),
        Command::Connect(name) => {
            if let Err(e) = connect_stdio(&name) {
                eprintln!("podium-host connect: {e}");
                std::process::exit(if matches!(e.raw_os_error(), Some(2 | 3)) { 4 } else { 5 });
            }
        }
        Command::Create(opts) => {
            if let Some(report) = std::env::var_os("PODIUM_HOST_WINDOWS_REPORT") {
                // Only the re-exec child sees this environment variable. Keep
                // it out of the hosted program's environment.
                unsafe {
                    std::env::remove_var("PODIUM_HOST_WINDOWS_REPORT");
                }
                let result = (|| -> io::Result<_> {
                    let listener = Listener::bind(&opts.socket)?;
                    let ring = Ring::new(opts.ring_bytes);
                    let child = spawn_child(&opts)?;
                    if let Some(pidfile) = &opts.pidfile {
                        // A stale marker never establishes liveness; binding
                        // FIRST_PIPE_INSTANCE did that before touching it.
                        let path = Path::new(pidfile);
                        match fs::remove_file(path) {
                            Ok(()) => (),
                            Err(e) if e.kind() == io::ErrorKind::NotFound => (),
                            Err(e) => return Err(e),
                        }
                        protected_write(path, format!("{}\n", std::process::id()).as_bytes())?;
                    }
                    Ok((listener, ring, child))
                })();
                match result {
                    Ok((listener, ring, child)) => {
                        protected_write(Path::new(&report), b"OK\n")
                            .unwrap_or_else(|e| crate::die(format_args!("ready: {e}")));
                        let path = opts
                            .pidfile
                            .as_ref()
                            .map_or_else(|| PathBuf::from(&opts.socket), PathBuf::from);
                        let id = opts
                            .pidfile
                            .as_ref()
                            .map(|_| (std::process::id() as u64, 0));
                        let mut host =
                            Host::new(path, id, listener, (), child, ring, opts.linger_secs);
                        // ConPTY emits VT: use exactly the shared emulator and cut clock.
                        #[cfg(feature = "screen")]
                        if !opts.no_pty {
                            host.keep_screen(opts.screen_scrollback);
                        }
                        host.run()
                    }
                    Err(e) => {
                        let _ = protected_write(
                            Path::new(&report),
                            format!("podium-host: {e}\n").as_bytes(),
                        );
                        std::process::exit(
                            if e.kind() == io::ErrorKind::AddrInUse {
                                3
                            } else {
                                1
                            },
                        );
                    }
                }
            }
            let report = std::env::temp_dir().join(format!(
                "podium-host-ready-{}-{}",
                std::process::id(),
                random_suffix().unwrap()
            ));
            let mut launch = std::process::Command::new(std::env::current_exe().unwrap());
            launch
                .args(std::env::args_os().skip(1))
                .env("PODIUM_HOST_WINDOWS_REPORT", &report)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            let mut in_job = 0;
            check(unsafe { IsProcessInJob(GetCurrentProcess(), null_mut(), &mut in_job) })
                .unwrap_or_else(|e| crate::die(format_args!("job membership: {e}")));
            launch.creation_flags(
                DETACHED_PROCESS
                    | CREATE_NEW_PROCESS_GROUP
                    | if in_job != 0 {
                        CREATE_BREAKAWAY_FROM_JOB
                    } else {
                        0
                    },
            );
            let mut host = launch
                .spawn()
                .unwrap_or_else(|e| crate::die(format_args!("detached host launch: {e}")));
            let deadline = Instant::now() + Duration::from_secs(30);
            loop {
                if let Ok(msg) = fs::read(&report) {
                    let _ = fs::remove_file(&report);
                    if msg.starts_with(b"OK\n") {
                        std::process::exit(0);
                    }
                    let _ = io::stderr().write_all(&msg);
                    let code = host.wait().ok().and_then(|s| s.code()).unwrap_or(1);
                    std::process::exit(code);
                }
                if let Ok(Some(status)) = host.try_wait() {
                    let _ = fs::remove_file(&report);
                    crate::die(format_args!("detached host exited before ready: {status}"));
                }
                if Instant::now() >= deadline {
                    let _ = host.kill();
                    let _ = host.wait();
                    let _ = fs::remove_file(&report);
                    crate::die(format_args!(
                        "detached host did not report ready within 30s"
                    ));
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unsupported_signals_never_terminate_and_pipe_interrupt_is_explicit() {
        for signal in [0, 1, 18, 19, 28] { assert_eq!(termination_status(signal), None); }
        assert_eq!(termination_status(2), Some(130));
        assert_eq!(termination_status(9), Some(137));
        assert_eq!(termination_status(15), Some(143));
    }
    #[test]
    fn bare_programs_do_not_search_the_session_directory() {
        let name = format!("podium-cwd-hijack-{}.exe", std::process::id());
        let cwd = std::env::current_dir().unwrap();
        let planted = cwd.join(&name);
        fs::write(&planted, b"not an agent").unwrap();
        let other = cwd.join("target").join("no-agent-here");
        let result = resolve_program_on_path(&name, other.as_os_str(), ".EXE;.CMD");
        let explicit = resolve_program_on_path(&format!(r".\{name}"), other.as_os_str(), ".EXE;.CMD");
        fs::remove_file(planted).unwrap();
        assert!(result.is_err());
        assert!(explicit.is_ok());
    }
    #[test]
    fn authenticated_client_checks_owner_on_its_handle_and_cannot_act_as_client() {
        let name = OsString::from(format!(r"\\.\pipe\podium-host-auth-test-{}", std::process::id()));
        let listener = Listener::bind(&name).unwrap();
        let client = authenticated_pipe(&name).unwrap();
        // A different expected owner is rejected using the real server token.
        let mut other = null_mut();
        check(unsafe { ConvertStringSidToSidW(wide("S-1-1-0").as_ptr(), &mut other) }).unwrap();
        let refused = verify_server(client.handle.0, other);
        unsafe { LocalFree(other); }
        assert_eq!(refused.unwrap_err().kind(), io::ErrorKind::PermissionDenied);
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match (&client).write(b"identify") {
                Ok(_) => break,
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => (),
                Err(e) => panic!("{e}"),
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
        let (server, _) = listener.accept().unwrap();
        let mut bytes = [0; 8];
        loop {
            match (&server).read(&mut bytes) {
                Ok(8) => break,
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => (),
                other => panic!("{other:?}"),
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
        check(unsafe { ImpersonateNamedPipeClient(server.handle.0) }).unwrap();
        let mut token = null_mut();
        let opened = unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut token) };
        let mut level = SecurityAnonymous;
        let mut len = 0;
        let queried = if opened != 0 { unsafe {
            GetTokenInformation(token, TokenImpersonationLevel, (&mut level as *mut _).cast(), size_of_val(&level) as u32, &mut len)
        }} else { 0 };
        unsafe { RevertToSelf(); if !token.is_null() { CloseHandle(token); } }
        assert_ne!(queried, 0);
        assert_eq!(level, SecurityIdentification);
    }
    #[test]
    fn windows_argv_quotes_empty_unicode_and_backslashes() {
        assert_eq!(quote_arg(""), "\"\"");
        assert_eq!(quote_arg("hello world"), "\"hello world\"");
        assert_eq!(
            quote_arg("c:\\path with space\\"),
            "\"c:\\path with space\\\\\""
        );
        assert_eq!(quote_arg("a\"b"), "\"a\\\"b\"");
        assert_eq!(quote_arg("日本語"), "日本語");
        assert_eq!(quote_arg("-NoExit"), "-NoExit");
    }
    #[test]
    fn protected_dacl_grants_only_the_current_user() {
        let security = Security::current_user().unwrap();
        unsafe {
            let mut dacl = null_mut();
            let mut present = 0;
            let mut defaulted = 0;
            assert_ne!(
                GetSecurityDescriptorDacl(
                    security.descriptor,
                    &mut present,
                    &mut dacl,
                    &mut defaulted
                ),
                0
            );
            assert_ne!(present, 0);
            assert!(!dacl.is_null());
            assert_eq!((*dacl).AceCount, 1);
            let mut control = 0;
            let mut revision = 0;
            assert_ne!(
                GetSecurityDescriptorControl(security.descriptor, &mut control, &mut revision),
                0
            );
            assert_ne!(control & SE_DACL_PROTECTED as u16, 0);
            let mut owner = null_mut();
            assert_ne!(
                GetSecurityDescriptorOwner(security.descriptor, &mut owner, &mut defaulted),
                0
            );
            let mut ace = null_mut();
            assert_ne!(GetAce(dacl, 0, &mut ace), 0);
            let ace = &*(ace.cast::<ACCESS_ALLOWED_ACE>());
            assert_eq!(ace.Header.AceType, 0); // ACCESS_ALLOWED_ACE_TYPE
            assert_eq!(ace.Mask, GENERIC_ALL);
            assert_ne!(
                EqualSid(owner, (&ace.SidStart as *const u32).cast_mut().cast()),
                0
            );
        }
    }
    #[test]
    fn listener_refuses_nonlocal_names() {
        assert!(Listener::bind(OsStr::new(r"\\remote\pipe\podium-host-test")).is_err());
        assert!(Listener::bind(OsStr::new(r"C:\tmp\foo.sock")).is_err());
    }
}
