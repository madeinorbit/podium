//! Public address probes and their consecutive-failure policy. No probe before DNS settles.
use std::io::Read;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

#[derive(Clone, Debug)]
pub struct Health {
    pub state: &'static str,
    pub url: Option<String>,
    pub last_ok_at: Option<u64>,
    pub failed_since: Option<u64>,
    pub last_error: Option<String>,
    failures: u8,
}

impl Health {
    pub fn new() -> Self {
        Self { state: "starting", url: None, last_ok_at: None, failed_since: None, last_error: None, failures: 0 }
    }
    pub fn starting(&mut self, url: String) {
        // A new address never inherits a success or failure from the previous one.
        *self = Self::new();
        self.url = Some(url);
    }
    pub fn restarting(&mut self) {
        self.state = "restarting";
    }
    /// True only after three consecutive failures; a success resets the streak.
    pub fn observe(&mut self, result: &Result<(), String>, now: u64) -> bool {
        match result {
            Ok(()) => {
                self.failures = 0;
                self.state = "working";
                self.last_ok_at = Some(now);
                self.failed_since = None;
                self.last_error = None;
                false
            }
            Err(error) => {
                self.failures = self.failures.saturating_add(1);
                self.state = "unhealthy";
                self.failed_since.get_or_insert(now);
                self.last_error = Some(error.chars().take(512).collect());
                self.failures >= 3
            }
        }
    }
    pub fn body(&self) -> String {
        serde_json::json!({ "state": self.state, "url": self.url,
            "lastOkAt": self.last_ok_at, "failedSince": self.failed_since,
            "lastError": self.last_error }).to_string()
    }
}

pub fn probe(url: &str, timeout: Duration) -> Result<(), String> {
    let agent = ureq::AgentBuilder::new().timeout(timeout).redirects(0).build();
    let response = agent.get(&format!("{}/version", url.trim_end_matches('/'))).call()
        .map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    response.into_reader().take(65_537).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
    if bytes.len() > 65_536 { return Err("The address sent too much data.".into()); }
    let body: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| "The address did not answer as Podium.".to_string())?;
    if body["wireVersion"].is_number() && body["appVersion"].is_string() {
        Ok(())
    } else { Err("The address did not answer as Podium.".into()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn success_resets_the_streak_and_rotations_reset_the_report() {
        let mut health = Health::new();
        health.starting("https://one.trycloudflare.com".into());
        assert!(!health.observe(&Err("timeout".into()), 10));
        assert!(!health.observe(&Err("timeout".into()), 20));
        assert_eq!(health.failed_since, Some(10));
        assert!(!health.observe(&Ok(()), 30));
        assert_eq!(health.last_ok_at, Some(30));
        assert_eq!(health.failed_since, None);
        for at in [40, 50] { assert!(!health.observe(&Err("timeout".into()), at)); }
        assert!(health.observe(&Err("timeout".into()), 60));
        health.restarting();
        assert_eq!(health.state, "restarting");
        health.starting("https://two.trycloudflare.com".into());
        assert_eq!(health.last_ok_at, None);
        assert!(!health.observe(&Err("timeout".into()), 70));
        let body: serde_json::Value = serde_json::from_str(&health.body()).unwrap();
        assert_eq!(body["url"], "https://two.trycloudflare.com");
        assert_eq!(body["failedSince"], 70);
    }
    #[test]
    fn checks_the_response_body_not_only_http_success() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        for (body, ok) in [(r#"{"wireVersion":1,"appVersion":"dev"}"#, true), ("<html>proxy error</html>", false)] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let worker = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut buf = [0u8; 1024];
                let n = stream.read(&mut buf).unwrap();
                assert!(String::from_utf8_lossy(&buf[..n]).starts_with("GET /version "));
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            });
            assert_eq!(probe(&url, Duration::from_secs(1)).is_ok(), ok);
            worker.join().unwrap();
        }
    }
}
