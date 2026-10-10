//! Waiting until a new quick-tunnel hostname resolves, before anyone is told it.
//!
//! WHY (POD-3274). cloudflared prints its URL a second or so before Cloudflare's
//! DNS serves the name. Whoever looks it up in that second gets NXDOMAIN, and
//! every caching resolver on the way keeps that answer for the zone's negative
//! TTL — 60 s for trycloudflare.com. A joined daemon that hears the URL at once
//! asks at once, gets the cached "no such name" for a minute, and stays stranded
//! that long. Measured on the lab: 75 s to follow a restart, of which ~60 s was
//! that cache.
//!
//! So the URL is held back until the name resolves AT ITS AUTHORITATIVE
//! NAMESERVERS. Those answer from the zone itself and cache nothing, so asking
//! them early poisons nothing: until this says yes, nobody else has the name
//! to ask about. Every one of the zone's nameservers must answer — a resolver
//! may ask any of them, and one that lags would hand out a cached NXDOMAIN.
//!
//! BOUNDED, AND NEVER A REASON NOT TO PUBLISH. When the nameservers cannot be
//! asked (a network that only lets its own resolver speak DNS) the wait is a
//! fixed delay instead; when they never agree within the cap, the URL is
//! published anyway. A late answer costs a joined machine one retry, never
//! the address.
//!
//! Plain UDP DNS from std: one A query, one NS query, enough parsing to read
//! a response code, an answer count and NS names. No new dependency.

use std::fs;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs, UdpSocket};
use std::thread;
use std::time::{Duration, Instant};

/// How long one DNS query waits for its answer.
const QUERY_TIMEOUT: Duration = Duration::from_millis(1_500);
/// Between rounds of asking the nameservers.
const POLL_INTERVAL: Duration = Duration::from_millis(500);

const TYPE_A: u16 = 1;
const TYPE_NS: u16 = 2;
const RCODE_NOERROR: u8 = 0;

/// What the wait ended with, for the log line.
#[derive(Debug, PartialEq, Eq)]
pub enum Published {
    /// Every authoritative nameserver answered with an address.
    Resolves { nameservers: usize, after: Duration },
    /// The nameservers did not all answer within the cap; publishing anyway.
    TimedOut { after: Duration },
    /// The nameservers could not be asked at all; waited the fixed delay instead.
    FixedDelay { reason: String, after: Duration },
    /// The wait is turned off (`--dns-wait-ms 0`).
    Skipped,
}

pub struct WaitConfig {
    /// The most this waits for the nameservers to agree. Zero turns the wait off.
    pub cap: Duration,
    /// The wait when the nameservers cannot be asked.
    pub fallback: Duration,
    /// Ask exactly these servers instead of discovering the zone's nameservers.
    /// For tests, which cannot reach Cloudflare.
    pub authorities: Option<Vec<SocketAddr>>,
}

/// Block until `host` resolves at every one of its zone's nameservers, or the
/// cap passes, or — when they cannot be asked — the fixed fallback delay passes.
pub fn wait_until_resolvable(host: &str, config: &WaitConfig) -> Published {
    if config.cap.is_zero() {
        return Published::Skipped;
    }
    let started = Instant::now();
    let authorities = match &config.authorities {
        Some(list) => list.clone(),
        None => match zone_nameservers(host) {
            Ok(list) => list,
            Err(reason) => return fixed_delay(reason, config.fallback, started),
        },
    };
    let mut ever_answered = false;
    loop {
        let mut resolved = 0;
        for server in &authorities {
            if let Ok(answer) = query(*server, host, TYPE_A, false) {
                ever_answered = true;
                if answer.rcode == RCODE_NOERROR && answer.answers > 0 {
                    resolved += 1;
                }
            }
        }
        if resolved == authorities.len() {
            return Published::Resolves { nameservers: resolved, after: started.elapsed() };
        }
        if !ever_answered && started.elapsed() >= QUERY_TIMEOUT {
            // Not one reply from any nameserver: direct DNS is blocked here, so
            // their silence says nothing about the name. Fall back to waiting.
            let reason = "no nameserver answered a direct query".to_string();
            return fixed_delay(reason, config.fallback, started);
        }
        if started.elapsed() + POLL_INTERVAL >= config.cap {
            return Published::TimedOut { after: started.elapsed() };
        }
        thread::sleep(POLL_INTERVAL);
    }
}

fn fixed_delay(reason: String, fallback: Duration, started: Instant) -> Published {
    let remaining = fallback.saturating_sub(started.elapsed());
    thread::sleep(remaining);
    Published::FixedDelay { reason, after: started.elapsed() }
}

/// The zone a quick-tunnel host lives in: everything after its first label.
fn parent_zone(host: &str) -> Option<&str> {
    host.split_once('.').map(|(_, zone)| zone).filter(|zone| zone.contains('.'))
}

/// The zone's nameservers, as addresses: an NS query to this machine's own
/// resolver (a positive, long-lived answer, so asking it is harmless), then the
/// system resolver for each nameserver's address.
fn zone_nameservers(host: &str) -> Result<Vec<SocketAddr>, String> {
    let zone = parent_zone(host).ok_or_else(|| format!("{host} has no parent zone"))?;
    let resolver = system_resolver().ok_or("no nameserver in /etc/resolv.conf")?;
    let answer = query(resolver, zone, TYPE_NS, true)
        .map_err(|error| format!("NS query for {zone} failed: {error}"))?;
    if answer.ns_names.is_empty() {
        return Err(format!("no NS records for {zone}"));
    }
    let mut servers = Vec::new();
    for name in &answer.ns_names {
        let found = (name.as_str(), 53)
            .to_socket_addrs()
            .ok()
            .and_then(|mut addrs| addrs.find(|addr| addr.is_ipv4()));
        if let Some(addr) = found {
            servers.push(addr);
        }
    }
    if servers.is_empty() {
        return Err(format!("could not resolve any nameserver of {zone}"));
    }
    Ok(servers)
}

/// The first `nameserver` line of /etc/resolv.conf.
fn system_resolver() -> Option<SocketAddr> {
    let text = fs::read_to_string("/etc/resolv.conf").ok()?;
    text.lines().find_map(|line| {
        let mut words = line.split_whitespace();
        if words.next()? != "nameserver" {
            return None;
        }
        let ip: IpAddr = words.next()?.parse().ok()?;
        Some(SocketAddr::new(ip, 53))
    })
}

#[derive(Debug, Default)]
pub struct Answer {
    pub rcode: u8,
    pub answers: u16,
    /// NS names from the answer section, for an NS query.
    pub ns_names: Vec<String>,
}

fn query(server: SocketAddr, name: &str, qtype: u16, recursion: bool) -> Result<Answer, String> {
    let bind = if server.is_ipv4() { "0.0.0.0:0" } else { "[::]:0" };
    let socket = UdpSocket::bind(bind).map_err(|e| e.to_string())?;
    socket.set_read_timeout(Some(QUERY_TIMEOUT)).map_err(|e| e.to_string())?;
    let id = query_id();
    let packet = build_query(id, name, qtype, recursion)?;
    socket.send_to(&packet, server).map_err(|e| e.to_string())?;
    let mut buf = [0u8; 1500];
    let deadline = Instant::now() + QUERY_TIMEOUT;
    loop {
        let (len, from) = socket.recv_from(&mut buf).map_err(|e| e.to_string())?;
        // A stray datagram from elsewhere, or an old reply, is not this answer.
        if from == server && len >= 2 && u16::from_be_bytes([buf[0], buf[1]]) == id {
            return parse_response(&buf[..len]);
        }
        if Instant::now() >= deadline {
            return Err("timed out".to_string());
        }
    }
}

fn query_id() -> u16 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    (nanos ^ std::process::id()) as u16
}

pub fn build_query(id: u16, name: &str, qtype: u16, recursion: bool) -> Result<Vec<u8>, String> {
    let mut packet = Vec::with_capacity(32 + name.len());
    packet.extend_from_slice(&id.to_be_bytes());
    packet.extend_from_slice(&[if recursion { 0x01 } else { 0x00 }, 0x00]);
    packet.extend_from_slice(&[0, 1, 0, 0, 0, 0, 0, 0]); // 1 question
    for label in name.trim_end_matches('.').split('.') {
        if label.is_empty() || label.len() > 63 {
            return Err(format!("not a DNS name: {name}"));
        }
        packet.push(label.len() as u8);
        packet.extend_from_slice(label.as_bytes());
    }
    packet.push(0);
    packet.extend_from_slice(&qtype.to_be_bytes());
    packet.extend_from_slice(&1u16.to_be_bytes()); // IN
    Ok(packet)
}

pub fn parse_response(msg: &[u8]) -> Result<Answer, String> {
    if msg.len() < 12 {
        return Err("short DNS response".to_string());
    }
    if msg[2] & 0x80 == 0 {
        return Err("not a DNS response".to_string());
    }
    let rcode = msg[3] & 0x0f;
    let questions = u16::from_be_bytes([msg[4], msg[5]]);
    let answers = u16::from_be_bytes([msg[6], msg[7]]);
    let mut at = 12;
    for _ in 0..questions {
        at = skip_name(msg, at)? + 4;
    }
    let mut ns_names = Vec::new();
    for _ in 0..answers {
        at = skip_name(msg, at)?;
        let header = msg.get(at..at + 10).ok_or("truncated answer")?;
        let rtype = u16::from_be_bytes([header[0], header[1]]);
        let rdlen = u16::from_be_bytes([header[8], header[9]]) as usize;
        let rdata = at + 10;
        if rdata + rdlen > msg.len() {
            return Err("truncated answer".to_string());
        }
        if rtype == TYPE_NS {
            ns_names.push(read_name(msg, rdata)?);
        }
        at = rdata + rdlen;
    }
    Ok(Answer { rcode, answers, ns_names })
}

/// The offset just past the (possibly compressed) name at `at`.
fn skip_name(msg: &[u8], mut at: usize) -> Result<usize, String> {
    loop {
        let len = *msg.get(at).ok_or("truncated name")? as usize;
        if len == 0 {
            return Ok(at + 1);
        }
        if len & 0xc0 == 0xc0 {
            return Ok(at + 2);
        }
        at += 1 + len;
    }
}

/// The name at `at`, following compression pointers (a bounded number of them).
fn read_name(msg: &[u8], mut at: usize) -> Result<String, String> {
    let mut labels: Vec<String> = Vec::new();
    for _ in 0..64 {
        let len = *msg.get(at).ok_or("truncated name")? as usize;
        if len == 0 {
            return Ok(labels.join("."));
        }
        if len & 0xc0 == 0xc0 {
            let low = *msg.get(at + 1).ok_or("truncated pointer")? as usize;
            at = ((len & 0x3f) << 8) | low;
            continue;
        }
        let label = msg.get(at + 1..at + 1 + len).ok_or("truncated label")?;
        labels.push(String::from_utf8_lossy(label).to_ascii_lowercase());
        at += 1 + len;
    }
    Err("name has too many labels or a pointer loop".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A response to `query`, with the given rcode and answer records appended.
    fn respond(query: &[u8], rcode: u8, answers: &[(u16, Vec<u8>)]) -> Vec<u8> {
        let mut msg = query.to_vec();
        msg[2] = 0x80 | msg[2];
        msg[3] = rcode;
        msg[6..8].copy_from_slice(&(answers.len() as u16).to_be_bytes());
        for (rtype, rdata) in answers {
            msg.extend_from_slice(&[0xc0, 12]); // name: pointer to the question
            msg.extend_from_slice(&rtype.to_be_bytes());
            msg.extend_from_slice(&[0, 1, 0, 0, 0, 60]);
            msg.extend_from_slice(&(rdata.len() as u16).to_be_bytes());
            msg.extend_from_slice(rdata);
        }
        msg
    }

    #[test]
    fn builds_a_question_without_recursion_for_an_authority() {
        let q = build_query(0x1234, "a-b.trycloudflare.com", TYPE_A, false).unwrap();
        assert_eq!(&q[..4], &[0x12, 0x34, 0x00, 0x00]);
        assert_eq!(&q[12..16], &[3, b'a', b'-', b'b']);
        assert_eq!(&q[q.len() - 4..], &[0, 1, 0, 1]);
        assert_eq!(build_query(1, "x.example", TYPE_NS, true).unwrap()[2], 0x01);
    }

    #[test]
    fn reads_nxdomain_and_an_address() {
        let q = build_query(7, "a.trycloudflare.com", TYPE_A, false).unwrap();
        let nx = parse_response(&respond(&q, 3, &[])).unwrap();
        assert_eq!((nx.rcode, nx.answers), (3, 0));
        let ok = parse_response(&respond(&q, 0, &[(TYPE_A, vec![104, 16, 230, 132])])).unwrap();
        assert_eq!((ok.rcode, ok.answers), (0, 1));
    }

    #[test]
    fn reads_ns_names_through_compression() {
        let q = build_query(9, "trycloudflare.com", TYPE_NS, true).unwrap();
        // "kevin.ns.cloudflare.com", then "marjory" + pointer to "ns.cloudflare.com".
        let first = b"\x05kevin\x02ns\x0acloudflare\x03com\x00".to_vec();
        let mut msg = respond(&q, 0, &[(TYPE_NS, first.clone())]);
        // The first record's data starts after its 12-byte header; "ns.cloudflare.com"
        // sits 6 bytes into it, past "\x05kevin".
        let kevin_rdata_at = q.len() + 12;
        let second = [b"\x07marjory".as_slice(), &[0xc0, (kevin_rdata_at + 6) as u8]].concat();
        msg[6..8].copy_from_slice(&2u16.to_be_bytes());
        msg.extend_from_slice(&[0xc0, 12]);
        msg.extend_from_slice(&TYPE_NS.to_be_bytes());
        msg.extend_from_slice(&[0, 1, 0, 0, 0, 60]);
        msg.extend_from_slice(&(second.len() as u16).to_be_bytes());
        msg.extend_from_slice(&second);
        let answer = parse_response(&msg).unwrap();
        assert_eq!(answer.ns_names, vec!["kevin.ns.cloudflare.com", "marjory.ns.cloudflare.com"]);
    }

    #[test]
    fn refuses_garbage_rather_than_reading_past_it() {
        assert!(parse_response(&[0; 5]).is_err());
        let q = build_query(1, "a.trycloudflare.com", TYPE_A, false).unwrap();
        let mut truncated = respond(&q, 0, &[(TYPE_A, vec![1, 2, 3, 4])]);
        truncated.truncate(truncated.len() - 2);
        assert!(parse_response(&truncated).is_err());
    }

    #[test]
    fn the_zone_is_everything_after_the_first_label() {
        assert_eq!(parent_zone("a-b.trycloudflare.com"), Some("trycloudflare.com"));
        assert_eq!(parent_zone("localhost"), None);
        assert_eq!(parent_zone("a.com"), None);
    }

    #[test]
    fn a_zero_cap_skips_the_wait() {
        let config = WaitConfig { cap: Duration::ZERO, fallback: Duration::ZERO, authorities: None };
        assert_eq!(wait_until_resolvable("a.trycloudflare.com", &config), Published::Skipped);
    }
}
