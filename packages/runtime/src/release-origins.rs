// Native adapter for release-origins.ts; addresses and trust are ONLY in the shared policy.
use reqwest::Url;
use serde::Deserialize;
use serde_json::Value;
use std::sync::{Mutex, OnceLock};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Policy {
    mirror_read_enabled: bool,
    redirect_hops: usize,
    paths: Paths,
    origins: Vec<Origin>,
}
#[derive(Deserialize)]
struct Paths { download: String, edge: String, dev: String }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Origin { id: String, base_url: String, latest_path: String, redirect_hosts: Vec<String> }

fn policy() -> &'static Policy {
    static POLICY: OnceLock<Policy> = OnceLock::new();
    POLICY.get_or_init(|| serde_json::from_str(include_str!("release-origins.json")).expect("release origin policy"))
}
fn origins() -> impl Iterator<Item = &'static Origin> {
    policy().origins.iter().filter(|origin| origin.id != "mirror" || policy().mirror_read_enabled)
}
fn base(origin: &Origin) -> Url { Url::parse(&origin.base_url).expect("release origin URL") }

pub fn endpoints(channel: &str) -> Vec<String> {
    origins().map(|origin| {
        let path = match channel {
            "stable" => &origin.latest_path,
            "edge" => &policy().paths.edge,
            "dev" => &policy().paths.dev,
            _ => panic!("unknown release channel"),
        };
        base(origin).join(&format!("{path}latest.json")).unwrap().to_string()
    }).collect()
}

// Same fixed-point decoding as the TypeScript adapter, including nested separators.
fn segments(path: &str) -> Option<Vec<String>> {
    path.split('/').filter(|segment| !segment.is_empty()).map(|segment| {
        let mut current = segment.to_string();
        for _ in 0..8 {
            let bytes = current.as_bytes();
            let mut decoded = Vec::new();
            let mut i = 0;
            while i < bytes.len() {
                if bytes[i] == b'%' {
                    let hex = std::str::from_utf8(bytes.get(i+1..i+3)?).ok()?;
                    decoded.push(u8::from_str_radix(hex, 16).ok()?);
                    i += 3;
                } else { decoded.push(bytes[i]); i += 1; }
            }
            let next = String::from_utf8(decoded).ok()?;
            if next == "." || next == ".." || next.contains(['/', '\\']) { return None; }
            if next == current { return Some(next); }
            current = next;
        }
        None
    }).collect()
}
fn belongs(url: &Url, directory: &Url) -> bool {
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() || url.origin() != directory.origin() { return false; }
    match (segments(url.path()), segments(directory.path())) {
        (Some(path), Some(prefix)) => path.len() > prefix.len() && path.starts_with(&prefix),
        _ => false,
    }
}
fn origin_for(url: &Url) -> Option<&'static Origin> { origins().find(|origin| belongs(url, &base(origin))) }

fn bind_url(value: &mut Value, origin: &Origin) -> Result<(), String> {
    let name = value.as_str().ok_or("invalid release artifact URL")?;
    let url = Url::parse(name).or_else(|_| base(origin).join(name)).map_err(|_| "invalid release artifact URL")?;
    let fence = base(origin).join(&policy().paths.download).unwrap();
    if !belongs(&url, &fence) { return Err("artifact is served from outside the release feed".into()); }
    *value = Value::String(url.to_string());
    Ok(())
}

pub fn bind_manifest(endpoint: &Url, mut raw: Value) -> Result<Value, String> {
    // Private dev feeds re-serve a validated public desktop document, unchanged.
    let Some(origin) = origin_for(endpoint) else { return Ok(raw); };
    if let Some(platforms) = raw.get_mut("platforms").and_then(Value::as_object_mut) {
        for artifact in platforms.values_mut() { bind_url(&mut artifact["url"], origin)?; }
    }
    if let Some(downloads) = raw.get_mut("downloads").and_then(Value::as_array_mut) {
        for url in downloads { bind_url(url, origin)?; }
    }
    static LAST_SUCCESS: Mutex<Option<String>> = Mutex::new(None);
    if let Ok(mut last) = LAST_SUCCESS.lock() { *last = Some(origin.id.clone()); }
    log::debug!("release manifest served by {}", origin.id);
    Ok(raw)
}

pub fn redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        let origin = attempt.previous().first().and_then(origin_for);
        let next = attempt.url();
        let allowed = origin.is_some_and(|origin| {
            next.scheme() == "https" && next.username().is_empty() && next.password().is_none()
                && next.port().is_none() && next.host_str().is_some_and(|host| origin.redirect_hosts.iter().any(|allowed| allowed == host))
        });
        if allowed && attempt.previous().len() <= policy().redirect_hops { attempt.follow() }
        else { attempt.error("release redirected outside its origin") }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn endpoint_order_and_artifact_fence() {
        let urls = endpoints("stable");
        assert_eq!(urls.len(), origins().count());
        assert!(urls[0].starts_with(&policy().origins[0].base_url));
        for origin in origins() {
            let endpoint = base(origin).join(&format!("{}latest.json", origin.latest_path)).unwrap();
            for name in ["download/../evil/a", "download/%252e%252e/a", "https://foreign.example/a"] {
                assert!(bind_manifest(&endpoint, serde_json::json!({"platforms":{"linux":{"url":name}}})).is_err());
            }
            for other in origins().filter(|other| other.id != origin.id) {
                let url = base(other).join("download/edge/a.tgz").unwrap();
                assert!(bind_manifest(&endpoint, serde_json::json!({"platforms":{"linux":{"url":url.as_str()}}})).is_err());
            }
            let bound = bind_manifest(&endpoint, serde_json::json!({"platforms":{"linux":{"url":"download/edge/a.tgz","signature":"sig"}}})).unwrap();
            assert_eq!(bound["platforms"]["linux"]["url"], base(origin).join("download/edge/a.tgz").unwrap().as_str());
        }
    }
}
