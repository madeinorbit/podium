//! The real podium-tunnel binary against a FAKE cloudflared (a shell script that
//! prints a scripted URL per run) and a FAKE control socket (records what it is
//! told). Never the real cloudflared, never the network.

use std::collections::VecDeque;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const A: &str = "https://prairie-otter-lamp-nine.trycloudflare.com";
const B: &str = "https://copper-hill-mango-seven.trycloudflare.com";

struct Scratch {
    dir: PathBuf,
}

impl Scratch {
    fn new(name: &str) -> Scratch {
        let dir = std::env::temp_dir().join(format!("podium-tunnel-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Scratch { dir }
    }
    fn path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn banner(url: &str) -> String {
    format!("printf '%s\\n' 'INF |  {url}                          |' >&2")
}

/// A fake cloudflared: run N executes `runs[N-1]` (the last entry repeats).
/// Every run records its pid in `pid.N` and bumps `count`.
fn fake_cloudflared(scratch: &Scratch, runs: &[&str]) -> PathBuf {
    let dir = scratch.dir.display();
    let mut cases = String::new();
    for (i, body) in runs.iter().enumerate() {
        let pattern = if i + 1 == runs.len() { "*".to_string() } else { (i + 1).to_string() };
        cases.push_str(&format!("  {pattern}) {body} ;;\n"));
    }
    let script = format!(
        "#!/bin/sh\nn=$(cat '{dir}/count' 2>/dev/null || echo 0)\nn=$((n+1))\necho $n > '{dir}/count'\necho $$ > '{dir}/pid.'$n\necho \"$*\" > '{dir}/argv'\ncase $n in\n{cases}esac\n"
    );
    let path = scratch.path("cloudflared");
    fs::write(&path, script).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    path
}

/// A fake control socket: answers each POST with the next scripted status
/// (200 once the script runs out) and records the posted URLs.
struct FakeServer {
    urls: Arc<Mutex<Vec<String>>>,
}

fn fake_server(socket: &Path, statuses: &[u16]) -> FakeServer {
    let listener = UnixListener::bind(socket).unwrap();
    let urls = Arc::new(Mutex::new(Vec::new()));
    let script = Arc::new(Mutex::new(statuses.iter().copied().collect::<VecDeque<u16>>()));
    let seen = urls.clone();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut length = 0usize;
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    break;
                }
                let lower = line.to_ascii_lowercase();
                if let Some(v) = lower.strip_prefix("content-length:") {
                    length = v.trim().parse().unwrap_or(0);
                }
                if line == "\r\n" {
                    break;
                }
            }
            let mut body = vec![0u8; length];
            reader.read_exact(&mut body).unwrap();
            let body = String::from_utf8(body).unwrap();
            assert!(body.contains("\"confirmUrlChange\":true"), "{body}");
            let url = body.split("\"url\":\"").nth(1).unwrap().split('"').next().unwrap().to_string();
            seen.lock().unwrap().push(url);
            let status = script.lock().unwrap().pop_front().unwrap_or(200);
            let reply = format!("{{\"ok\":{}}}", status == 200);
            let _ = write!(
                stream,
                "HTTP/1.1 {status} X\r\ncontent-length: {}\r\n\r\n{reply}",
                reply.len()
            );
        }
    });
    FakeServer { urls }
}

impl FakeServer {
    fn urls(&self) -> Vec<String> {
        self.urls.lock().unwrap().clone()
    }
}

fn start_tunnel(scratch: &Scratch, cloudflared: &Path, extra: &[&str]) -> Child {
    Command::new(env!("CARGO_BIN_EXE_podium-tunnel"))
        .args(["--origin", "http://127.0.0.1:18787"])
        .arg("--socket")
        .arg(scratch.path("control.sock"))
        .arg("--cloudflared")
        .arg(cloudflared)
        .arg("--lock")
        .arg(scratch.path("tunnel.lock"))
        .args([
            "--url-timeout-ms",
            "2000",
            "--kill-grace-ms",
            "300",
            "--stable-ms",
            "600000",
            "--backoff-ms",
            "50,100,200,400",
            "--post-backoff-ms",
            "50,100",
        ])
        .args(extra)
        .stdout(Stdio::null())
        .stderr(Stdio::from(fs::File::create(scratch.path(&format!("log.{}", extra.len()))).unwrap()))
        .spawn()
        .unwrap()
}

fn wait_until(what: &str, timeout: Duration, mut check: impl FnMut() -> bool) {
    let deadline = Instant::now() + timeout;
    while !check() {
        assert!(Instant::now() < deadline, "timed out waiting for: {what}");
        thread::sleep(Duration::from_millis(20));
    }
}

fn read_pid(scratch: &Scratch, name: &str) -> i32 {
    fs::read_to_string(scratch.path(name)).unwrap().trim().parse().unwrap()
}

fn runs(scratch: &Scratch) -> u32 {
    fs::read_to_string(scratch.path("count")).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0)
}

/// Alive and not a zombie.
fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 only probes.
    if unsafe { libc::kill(pid, 0) } != 0 {
        return false;
    }
    match fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => stat.rsplit_once(')').map(|(_, rest)| !rest.trim_start().starts_with('Z')).unwrap_or(true),
        Err(_) => true,
    }
}

fn terminate(child: &mut Child) -> i32 {
    // SAFETY: SIGTERM to the tunnel process we spawned.
    unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status.code().unwrap_or(-1);
        }
        assert!(Instant::now() < deadline, "podium-tunnel did not stop");
        thread::sleep(Duration::from_millis(20));
    }
}

fn exit_code_within(child: &mut Child, timeout: Duration) -> i32 {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status.code().unwrap_or(-1);
        }
        assert!(Instant::now() < deadline, "podium-tunnel did not exit");
        thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn a_rotation_posts_a_then_b() {
    let s = Scratch::new("rotation");
    let server = fake_server(&s.path("control.sock"), &[]);
    let cf = fake_cloudflared(&s, &[&format!("{}; sleep 0.3; exit 1", banner(A)), &format!("{}; exec sleep 300", banner(B))]);
    let mut tunnel = start_tunnel(&s, &cf, &[]);
    wait_until("A then B posted", Duration::from_secs(10), || server.urls() == [A, B]);
    assert_eq!(
        fs::read_to_string(s.path("argv")).unwrap().trim(),
        "tunnel --no-autoupdate --url http://127.0.0.1:18787"
    );
    let second = read_pid(&s, "pid.2");
    assert_eq!(terminate(&mut tunnel), 0);
    wait_until("cloudflared gone", Duration::from_secs(5), || !alive(second));
}

#[test]
fn a_restart_with_the_same_url_posts_nothing() {
    let s = Scratch::new("same");
    let server = fake_server(&s.path("control.sock"), &[]);
    let cf = fake_cloudflared(&s, &[&format!("{}; sleep 0.3; exit 1", banner(A)), &format!("{}; exec sleep 300", banner(A))]);
    let mut tunnel = start_tunnel(&s, &cf, &[]);
    wait_until("second run printed", Duration::from_secs(10), || runs(&s) >= 2);
    thread::sleep(Duration::from_millis(500));
    assert_eq!(server.urls(), [A]);
    assert_eq!(terminate(&mut tunnel), 0);
}

#[test]
fn a_cloudflared_that_keeps_dying_is_restarted_with_backoff_and_the_service_stays_up() {
    let s = Scratch::new("dying");
    let _server = fake_server(&s.path("control.sock"), &[]);
    let starts = s.path("starts");
    let cf = fake_cloudflared(&s, &[&format!("date +%s%N >> '{}'; exit 1", starts.display())]);
    // Delays well above the supervisor's 250 ms wake, so the GAPS measure the
    // backoff and not the polling: 300, 700, 1500 ms, then capped.
    let mut tunnel = start_tunnel(&s, &cf, &["--backoff-ms", "300,700,1500"]);
    // Wait on the TIMESTAMPS, not the run counter: a run bumps its counter before it
    // writes its timestamp, so four runs can mean three lines.
    wait_until("four timestamped starts", Duration::from_secs(15), || {
        fs::read_to_string(&starts).map(|t| t.lines().count() >= 4).unwrap_or(false)
    });
    let times: Vec<u128> = fs::read_to_string(&starts)
        .unwrap()
        .lines()
        .map(|l| l.trim().parse::<u128>().unwrap() / 1_000_000)
        .collect();
    let gaps: Vec<u128> = times.windows(2).map(|w| w[1] - w[0]).collect();
    // Each gap is at LEAST its configured delay. Only lower bounds: under load a
    // start can be late, never early, so an upper bound or a strict ordering of
    // neighbouring gaps would measure the box, not the backoff.
    assert!(gaps[0] >= 300 && gaps[1] >= 700 && gaps[2] >= 1_500, "gaps {gaps:?} ms");
    assert!(tunnel.try_wait().unwrap().is_none(), "the service must stay up");
    assert_eq!(terminate(&mut tunnel), 0);
}

#[test]
fn stopping_the_service_takes_cloudflared_and_its_children_down() {
    let s = Scratch::new("stop");
    let _server = fake_server(&s.path("control.sock"), &[]);
    let helper = s.path("helper");
    let cf = fake_cloudflared(&s, &[&format!("{}; sleep 300 & echo $! > '{}'; wait", banner(A), helper.display())]);
    let mut tunnel = start_tunnel(&s, &cf, &[]);
    wait_until("helper started", Duration::from_secs(10), || helper.exists() && fs::read_to_string(&helper).map(|t| !t.trim().is_empty()).unwrap_or(false));
    let pid = read_pid(&s, "pid.1");
    let helper_pid = read_pid(&s, "helper");
    assert!(alive(pid) && alive(helper_pid));
    assert_eq!(terminate(&mut tunnel), 0);
    wait_until("no orphan", Duration::from_secs(5), || !alive(pid) && !alive(helper_pid));
}

#[test]
fn a_start_that_never_prints_a_url_is_a_failed_start_not_a_hang() {
    let s = Scratch::new("nourl");
    let server = fake_server(&s.path("control.sock"), &[]);
    let cf = fake_cloudflared(&s, &["exec sleep 300", &format!("{}; exec sleep 300", banner(A))]);
    let mut tunnel = start_tunnel(&s, &cf, &["--url-timeout-ms", "300"]);
    wait_until("the second run's URL posted", Duration::from_secs(10), || server.urls() == [A]);
    let first = read_pid(&s, "pid.1");
    wait_until("the silent run was killed", Duration::from_secs(5), || !alive(first));
    assert_eq!(terminate(&mut tunnel), 0);
}

#[test]
fn a_refusal_from_the_server_stops_the_service_with_78_and_takes_cloudflared_down() {
    let s = Scratch::new("refused");
    let server = fake_server(&s.path("control.sock"), &[409]);
    let cf = fake_cloudflared(&s, &[&format!("{}; exec sleep 300", banner(A))]);
    let mut tunnel = start_tunnel(&s, &cf, &[]);
    assert_eq!(exit_code_within(&mut tunnel, Duration::from_secs(10)), 78);
    assert_eq!(server.urls(), [A]);
    let pid = read_pid(&s, "pid.1");
    wait_until("cloudflared gone", Duration::from_secs(5), || !alive(pid));
}

#[test]
fn a_second_instance_refuses_while_one_is_running() {
    let s = Scratch::new("second");
    let _server = fake_server(&s.path("control.sock"), &[]);
    let cf = fake_cloudflared(&s, &[&format!("{}; exec sleep 300", banner(A))]);
    let mut first = start_tunnel(&s, &cf, &[]);
    wait_until("first running", Duration::from_secs(10), || runs(&s) >= 1);
    let mut second = start_tunnel(&s, &cf, &["--kill-grace-ms", "300"]);
    assert_eq!(exit_code_within(&mut second, Duration::from_secs(10)), 78);
    thread::sleep(Duration::from_millis(300));
    assert_eq!(runs(&s), 1, "the second instance must not start a cloudflared");
    assert!(first.try_wait().unwrap().is_none());
    assert_eq!(terminate(&mut first), 0);
}

#[test]
fn a_server_that_is_not_up_yet_gets_the_url_once_it_is() {
    let s = Scratch::new("late");
    let cf = fake_cloudflared(&s, &[&format!("{}; exec sleep 300", banner(A))]);
    let mut tunnel = start_tunnel(&s, &cf, &[]);
    wait_until("cloudflared started", Duration::from_secs(10), || runs(&s) >= 1);
    thread::sleep(Duration::from_millis(400));
    let server = fake_server(&s.path("control.sock"), &[]);
    wait_until("posted after the server came up", Duration::from_secs(10), || server.urls() == [A]);
    assert_eq!(terminate(&mut tunnel), 0);
}

#[cfg(target_os = "linux")]
#[test]
fn a_killed_service_does_not_leave_cloudflared_behind() {
    let s = Scratch::new("sigkill");
    let _server = fake_server(&s.path("control.sock"), &[]);
    let cf = fake_cloudflared(&s, &[&format!("{}; exec sleep 300", banner(A))]);
    let mut tunnel = start_tunnel(&s, &cf, &[]);
    wait_until("cloudflared started", Duration::from_secs(10), || s.path("pid.1").exists());
    let pid = read_pid(&s, "pid.1");
    tunnel.kill().unwrap();
    tunnel.wait().unwrap();
    wait_until("cloudflared gone with its parent", Duration::from_secs(5), || !alive(pid));
}
