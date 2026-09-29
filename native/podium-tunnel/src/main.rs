//! podium-tunnel — keeps a Cloudflare QUICK tunnel running and tells the Podium
//! server each new URL it gets (POD-4640).
//!
//! A quick tunnel mints a new `https://<random>.trycloudflare.com` every time
//! cloudflared starts. This program owns cloudflared as its child: it starts
//! it, reads the URL it prints, POSTs that URL to the server's control socket
//! (which publishes it to Podium Connect at once), restarts cloudflared with
//! backoff whenever it dies, and takes it down when told to stop.
//!
//! It lives OUTSIDE the Podium process on purpose: the URL only changes when
//! cloudflared restarts, so it must not restart when Podium restarts or updates.
//!
//! Exit codes: 0 after a stop signal; 78 (EX_CONFIG) when it can never do its
//! job — the server refused the URL (PODIUM_PUBLIC_URL owns it, or this box is
//! not a server), or another podium-tunnel already runs. The systemd unit does
//! not restart on 78; 2 is a usage error.

mod control;
mod url;

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, ExitCode, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread;
use std::time::{Duration, Instant};

use control::PostOutcome;

const EXIT_REFUSED: u8 = 78;
const EXIT_USAGE: u8 = 2;

const USAGE: &str = "usage: podium-tunnel --origin <http://127.0.0.1:PORT> --socket <control.sock> [--cloudflared <path>] [--lock <path>]";

fn log(message: &str) {
    eprintln!("podium-tunnel: {message}");
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

struct Config {
    origin: String,
    socket: PathBuf,
    cloudflared: String,
    lock: PathBuf,
    /// A start that prints no URL in this long is a failed start.
    url_timeout: Duration,
    /// SIGTERM, then SIGKILL after this long.
    kill_grace: Duration,
    /// A run that served a URL this long resets the restart backoff.
    stable_after: Duration,
    /// Restart delays. Fast first, because a quick tunnel dying is NORMAL; up to
    /// five minutes, because every start is a request to Cloudflare's API and a
    /// cloudflared that cannot start must not hammer it.
    backoff: Vec<Duration>,
    /// Delays between attempts to reach a server that is not answering yet.
    post_backoff: Vec<Duration>,
}

fn millis(list: &[u64]) -> Vec<Duration> {
    list.iter().map(|ms| Duration::from_millis(*ms)).collect()
}

fn parse_millis_list(value: &str) -> Result<Vec<Duration>, String> {
    let parsed: Result<Vec<u64>, _> = value.split(',').map(|s| s.trim().parse::<u64>()).collect();
    match parsed {
        Ok(list) if !list.is_empty() => Ok(millis(&list)),
        _ => Err(format!("not a list of milliseconds: {value}")),
    }
}

fn parse_millis(value: &str) -> Result<Duration, String> {
    value.parse::<u64>().map(Duration::from_millis).map_err(|_| format!("not milliseconds: {value}"))
}

fn parse_args(args: &[String]) -> Result<Config, String> {
    let mut origin = None;
    let mut socket = None;
    let mut cloudflared = "cloudflared".to_string();
    let mut lock = None;
    let mut config_url_timeout = Duration::from_secs(30);
    let mut kill_grace = Duration::from_secs(5);
    let mut stable_after = Duration::from_secs(60);
    let mut backoff = millis(&[1_000, 2_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000]);
    let mut post_backoff = millis(&[1_000, 2_000, 5_000, 10_000, 30_000]);
    let mut i = 0;
    while i < args.len() {
        let flag = args[i].as_str();
        let value = args.get(i + 1).cloned().ok_or_else(|| format!("{flag} needs a value"));
        match flag {
            "--origin" => origin = Some(value?),
            "--socket" => socket = Some(PathBuf::from(value?)),
            "--cloudflared" => cloudflared = value?,
            "--lock" => lock = Some(PathBuf::from(value?)),
            // Tuning, for tests; the defaults are the product.
            "--url-timeout-ms" => config_url_timeout = parse_millis(&value?)?,
            "--kill-grace-ms" => kill_grace = parse_millis(&value?)?,
            "--stable-ms" => stable_after = parse_millis(&value?)?,
            "--backoff-ms" => backoff = parse_millis_list(&value?)?,
            "--post-backoff-ms" => post_backoff = parse_millis_list(&value?)?,
            other => return Err(format!("unknown argument {other}")),
        }
        i += 2;
    }
    let origin = origin.ok_or("--origin is required")?;
    let socket = socket.ok_or("--socket is required")?;
    let lock = lock.unwrap_or_else(|| socket.with_file_name("tunnel.lock"));
    Ok(Config {
        origin,
        socket,
        cloudflared,
        lock,
        url_timeout: config_url_timeout,
        kill_grace,
        stable_after,
        backoff,
        post_backoff,
    })
}

// ---------------------------------------------------------------------------
// Signals: blocked everywhere, received by one thread with sigwait
// ---------------------------------------------------------------------------

fn stop_signals() -> libc::sigset_t {
    // SAFETY: sigemptyset/sigaddset only write the set we own.
    unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        libc::sigaddset(&mut set, libc::SIGTERM);
        libc::sigaddset(&mut set, libc::SIGINT);
        libc::sigaddset(&mut set, libc::SIGHUP);
        set
    }
}

/// Block the stop signals in this (the main) thread BEFORE any other thread
/// exists, so every thread inherits the mask and only the sigwait thread ever
/// sees them. The child gets a clean mask back in `pre_exec`.
fn block_stop_signals() {
    let set = stop_signals();
    // SAFETY: plain pthread_sigmask on our own thread with a valid set.
    unsafe {
        libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
    }
}

fn spawn_signal_thread(events: Sender<Event>) {
    thread::spawn(move || loop {
        let set = stop_signals();
        let mut signal: libc::c_int = 0;
        // SAFETY: sigwait on a valid set, writing into our own int.
        let rc = unsafe { libc::sigwait(&set, &mut signal) };
        if rc == 0 && events.send(Event::Signal(signal)).is_err() {
            return;
        }
    });
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

enum Event {
    /// A line cloudflared printed during run `run`.
    Line { run: u64, line: String },
    Signal(libc::c_int),
    /// The poster thread's answer for `url`.
    Posted { url: String, outcome: PostOutcome },
}

fn spawn_reader(run: u64, pipe: impl Read + Send + 'static, events: Sender<Event>) {
    thread::spawn(move || {
        let mut reader = BufReader::new(pipe);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => return,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buf).trim_end().to_string();
                    // cloudflared's own log goes on to ours, so the journal has it.
                    eprintln!("{line}");
                    if events.send(Event::Line { run, line }).is_err() {
                        return;
                    }
                }
            }
        }
    });
}

/// Posts URLs to the control socket, retrying while the server is unreachable.
/// Always posts the NEWEST URL: a rotation during a retry replaces the one
/// being retried, so a stale URL is never recorded after a fresher one.
fn spawn_poster(socket: PathBuf, delays: Vec<Duration>, urls: Receiver<String>, events: Sender<Event>) {
    thread::spawn(move || {
        while let Ok(mut url) = urls.recv() {
            let mut attempt = 0usize;
            loop {
                while let Ok(newer) = urls.try_recv() {
                    url = newer;
                }
                let outcome = match control::post_public_url(&socket, &url) {
                    Ok(PostOutcome::Retry { status }) => {
                        log(&format!("server answered {status}; will retry"));
                        None
                    }
                    Ok(done) => Some(done),
                    Err(error) => {
                        log(&format!("server not reachable on {} ({error}); will retry", socket.display()));
                        None
                    }
                };
                if let Some(outcome) = outcome {
                    if events.send(Event::Posted { url: url.clone(), outcome }).is_err() {
                        return;
                    }
                    break;
                }
                let delay = delays[attempt.min(delays.len() - 1)];
                attempt += 1;
                match urls.recv_timeout(delay) {
                    Ok(newer) => url = newer,
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
        }
    });
}

// ---------------------------------------------------------------------------
// The supervisor
// ---------------------------------------------------------------------------

enum Phase {
    /// Waiting for the running cloudflared to print its URL.
    Starting { deadline: Instant },
    /// cloudflared is serving; `since` is when it printed its URL.
    Running { since: Instant },
    /// No cloudflared; the next one starts at `until`.
    Backoff { until: Instant },
    /// Shutting down; exit once the child is gone.
    Stopping,
}

struct Supervisor {
    config: Config,
    events: Sender<Event>,
    urls: Sender<String>,
    child: Option<Child>,
    run: u64,
    phase: Phase,
    attempts: usize,
    kill_at: Option<Instant>,
    last_sent: Option<String>,
    exit_code: u8,
}

impl Supervisor {
    fn start_run(&mut self) {
        // The invariant everything leans on: a new cloudflared only once the
        // previous one's exit has been reaped. Two would be two URLs racing.
        debug_assert!(self.child.is_none());
        self.run += 1;
        let mut command = Command::new(&self.config.cloudflared);
        command
            // --no-autoupdate: cloudflared replacing its own binary and
            // restarting is a rotation nobody asked for.
            .args(["tunnel", "--no-autoupdate", "--url", &self.config.origin])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // Its own process group, so a stop reaches anything it starts.
            .process_group(0);
        // SAFETY: only async-signal-safe calls between fork and exec.
        unsafe {
            command.pre_exec(|| {
                let empty: libc::sigset_t = {
                    let mut set: libc::sigset_t = std::mem::zeroed();
                    libc::sigemptyset(&mut set);
                    set
                };
                libc::pthread_sigmask(libc::SIG_SETMASK, &empty, std::ptr::null_mut());
                // If this program is SIGKILLed, the kernel takes cloudflared
                // down too — no orphan holding a tunnel nobody records.
                #[cfg(target_os = "linux")]
                libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
                Ok(())
            });
        }
        match command.spawn() {
            Ok(mut child) => {
                if let Some(out) = child.stdout.take() {
                    spawn_reader(self.run, out, self.events.clone());
                }
                if let Some(err) = child.stderr.take() {
                    spawn_reader(self.run, err, self.events.clone());
                }
                log(&format!("started cloudflared (pid {}) for {}", child.id(), self.config.origin));
                self.child = Some(child);
                self.phase = Phase::Starting { deadline: Instant::now() + self.config.url_timeout };
            }
            Err(error) => {
                log(&format!("could not start {}: {error}", self.config.cloudflared));
                self.schedule_restart();
            }
        }
    }

    fn schedule_restart(&mut self) {
        let delay = self.config.backoff[self.attempts.min(self.config.backoff.len() - 1)];
        self.attempts += 1;
        log(&format!("restarting cloudflared in {} ms", delay.as_millis()));
        self.phase = Phase::Backoff { until: Instant::now() + delay };
    }

    fn signal_child(&self, signal: libc::c_int) {
        if let Some(child) = &self.child {
            let pid = child.id() as libc::pid_t;
            // SAFETY: signalling the process group we created for our own child.
            unsafe {
                if libc::kill(-pid, signal) != 0 {
                    libc::kill(pid, signal);
                }
            }
        }
    }

    fn terminate_child(&mut self) {
        if self.child.is_some() && self.kill_at.is_none() {
            self.signal_child(libc::SIGTERM);
            self.kill_at = Some(Instant::now() + self.config.kill_grace);
        }
    }

    fn stop(&mut self, exit_code: u8) {
        if matches!(self.phase, Phase::Stopping) {
            return;
        }
        self.exit_code = exit_code;
        self.phase = Phase::Stopping;
        self.terminate_child();
    }

    fn on_line(&mut self, run: u64, line: &str) {
        if run != self.run || !matches!(self.phase, Phase::Starting { .. }) {
            return;
        }
        let Some(found) = url::parse_quick_tunnel_url(line) else { return };
        log(&format!("cloudflared is serving {found}"));
        self.phase = Phase::Running { since: Instant::now() };
        // The same URL again writes nothing: no config churn, no republish.
        if self.last_sent.as_deref() != Some(found.as_str()) {
            self.last_sent = Some(found.clone());
            let _ = self.urls.send(found);
        }
    }

    fn on_posted(&mut self, url: String, outcome: PostOutcome) {
        match outcome {
            PostOutcome::Accepted => log(&format!("server recorded {url}")),
            PostOutcome::Refused { status, body } => {
                log(&format!("server refused {url} ({status}): {body}"));
                log("this cannot succeed by retrying; stopping");
                self.stop(EXIT_REFUSED);
            }
            PostOutcome::Retry { .. } => {}
        }
    }

    fn on_child_exit(&mut self, status: std::process::ExitStatus) {
        self.child = None;
        self.kill_at = None;
        if matches!(self.phase, Phase::Stopping) {
            return;
        }
        if let Phase::Running { since } = self.phase {
            if since.elapsed() >= self.config.stable_after {
                self.attempts = 0;
            }
        }
        // A restart is the normal case, not an error: quick tunnels die.
        log(&format!("cloudflared exited ({status})"));
        self.schedule_restart();
    }

    fn next_wake(&self) -> Duration {
        let now = Instant::now();
        let mut due = now + Duration::from_millis(250);
        match self.phase {
            Phase::Starting { deadline } => due = due.min(deadline),
            Phase::Backoff { until } => due = due.min(until),
            _ => {}
        }
        if let Some(kill_at) = self.kill_at {
            due = due.min(kill_at);
        }
        due.saturating_duration_since(now).max(Duration::from_millis(5))
    }

    fn tick(&mut self) {
        if let Some(child) = self.child.as_mut() {
            if let Ok(Some(status)) = child.try_wait() {
                self.on_child_exit(status);
            }
        }
        let now = Instant::now();
        if let Some(kill_at) = self.kill_at {
            if now >= kill_at {
                self.signal_child(libc::SIGKILL);
                self.kill_at = Some(now + Duration::from_secs(3600));
            }
        }
        match self.phase {
            Phase::Starting { deadline } if now >= deadline && self.kill_at.is_none() => {
                log(&format!(
                    "cloudflared printed no tunnel URL in {} ms; treating it as a failed start",
                    self.config.url_timeout.as_millis()
                ));
                self.terminate_child();
            }
            Phase::Backoff { until } if now >= until => self.start_run(),
            _ => {}
        }
    }

    fn done(&self) -> bool {
        matches!(self.phase, Phase::Stopping) && self.child.is_none()
    }
}

fn acquire_lock(path: &PathBuf) -> Result<File, String> {
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(path)
        .map_err(|e| format!("cannot open lock {}: {e}", path.display()))?;
    // Released by the kernel when this process ends, however it ends.
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(std::fs::TryLockError::WouldBlock) => {
            Err(format!("another podium-tunnel is already running (lock {})", path.display()))
        }
        Err(std::fs::TryLockError::Error(e)) => Err(format!("cannot lock {}: {e}", path.display())),
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("{USAGE}");
        return ExitCode::SUCCESS;
    }
    if args.iter().any(|a| a == "--version") {
        println!("podium-tunnel {}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }
    let config = match parse_args(&args) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("podium-tunnel: {error}\n{USAGE}");
            return ExitCode::from(EXIT_USAGE);
        }
    };
    let _lock = match acquire_lock(&config.lock) {
        Ok(file) => file,
        Err(error) => {
            log(&error);
            return ExitCode::from(EXIT_REFUSED);
        }
    };

    block_stop_signals();
    let (events_tx, events) = mpsc::channel::<Event>();
    let (urls_tx, urls_rx) = mpsc::channel::<String>();
    spawn_signal_thread(events_tx.clone());
    spawn_poster(config.socket.clone(), config.post_backoff.clone(), urls_rx, events_tx.clone());

    let mut supervisor = Supervisor {
        config,
        events: events_tx,
        urls: urls_tx,
        child: None,
        run: 0,
        phase: Phase::Backoff { until: Instant::now() },
        attempts: 0,
        kill_at: None,
        last_sent: None,
        exit_code: 0,
    };
    supervisor.start_run();
    loop {
        match events.recv_timeout(supervisor.next_wake()) {
            Ok(Event::Line { run, line }) => supervisor.on_line(run, &line),
            Ok(Event::Posted { url, outcome }) => supervisor.on_posted(url, outcome),
            Ok(Event::Signal(signal)) => {
                log(&format!("received signal {signal}; stopping cloudflared"));
                supervisor.stop(0);
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        supervisor.tick();
        if supervisor.done() {
            break;
        }
    }
    log("stopped");
    ExitCode::from(supervisor.exit_code)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn requires_origin_and_socket_and_derives_the_lock() {
        assert!(parse_args(&args(&["--socket", "/s"])).is_err());
        assert!(parse_args(&args(&["--origin", "http://127.0.0.1:1"])).is_err());
        let config = parse_args(&args(&["--origin", "http://127.0.0.1:1", "--socket", "/run/x/control.sock"])).unwrap();
        assert_eq!(config.lock, PathBuf::from("/run/x/tunnel.lock"));
        assert_eq!(config.cloudflared, "cloudflared");
        assert_eq!(config.backoff.last(), Some(&Duration::from_secs(300)));
    }

    #[test]
    fn refuses_unknown_arguments_and_bad_numbers() {
        assert!(parse_args(&args(&["--origin", "o", "--socket", "s", "--bogus", "1"])).is_err());
        assert!(parse_args(&args(&["--origin", "o", "--socket", "s", "--backoff-ms", "a,b"])).is_err());
        assert!(parse_args(&args(&["--origin", "o", "--socket"])).is_err());
    }
}
