//! Web access (issue #91): who may use the Jouzu web UI besides the desktop window.
//!
//! The desktop window keeps talking to the internal loopback listener with the
//! per-process token the host handed to the desktop when it started (never in a
//! file, #130); nothing here changes that path. Web access
//! adds separate listeners on a persistent port, only when the user turns it on:
//!
//! * `Off` (default): no extra listener at all.
//! * `Local`: `127.0.0.1:<port>`, for a browser on this computer.
//! * `Networks`: `Local` plus one listener per trusted network the user enabled
//!   (private LAN ranges and Tailscale). Public addresses and wildcard binds are
//!   never offered.
//!
//! Every web client must be paired: the desktop creates a one-time pairing code,
//! the browser exchanges it for its own device credential, and the host keeps only
//! a hash of that credential. Devices can be revoked one by one or all at once;
//! a revoke, a scope change or a network being turned off ends the device's
//! open event streams at once. The internal token is never accepted on a web
//! listener, and device credentials are never accepted on the internal one.

use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::watch;

pub const DEVICE_COOKIE: &str = "jouzu_device";
const FILE: &str = "web-access.json";
const SCHEMA: u32 = 1;
const PAIRING_LIFETIME: Duration = Duration::from_secs(5 * 60);
const PAIRING_ATTEMPTS: u32 = 5;
const MAX_DEVICES: usize = 32;
/// `last seen` is persisted at most this often per device, not on every request.
const SEEN_WRITE_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Off,
    Local,
    Networks,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NetworkKind {
    Lan,
    Tailnet,
}

/// Which listener a request arrived on. Requests without this extension came
/// through the internal listener (the desktop window and its tests).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Listener {
    Internal,
    Web { local: SocketAddr },
}

/// The device a web request was authenticated as.
#[derive(Debug, Clone)]
pub struct DeviceId(pub String);

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Device {
    id: String,
    name: String,
    /// sha256 of the device secret, hex.
    hash: String,
    network: String,
    #[serde(rename = "createdAt")]
    created_at: String,
    #[serde(rename = "lastSeen", default)]
    last_seen: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct Config {
    schema: u32,
    #[serde(default)]
    mode: Mode,
    /// Persistent port for every web listener; 0 until access is first enabled.
    #[serde(default)]
    port: u16,
    /// Interface names the user enabled as trusted networks.
    #[serde(default)]
    networks: Vec<String>,
    #[serde(default)]
    devices: Vec<Device>,
}

struct Pairing {
    hash: String,
    expires: Instant,
    attempts: u32,
}

/// A network interface that may be offered as a trusted network.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Interface {
    pub name: String,
    pub address: IpAddr,
    pub prefix: u8,
    pub kind: NetworkKind,
}

struct Inner {
    config: Config,
    pairing: Option<Pairing>,
    seen_written: HashMap<String, Instant>,
    /// Listener addresses that failed to bind, with the reason, for the settings page.
    failures: HashMap<SocketAddr, String>,
    /// Addresses currently being served.
    serving: Vec<SocketAddr>,
}

pub struct WebAccess {
    path: Option<PathBuf>,
    inner: Mutex<Inner>,
    changes: watch::Sender<u64>,
    scan: Box<dyn Fn() -> Vec<Interface> + Send + Sync>,
}

#[derive(Debug, Deserialize)]
pub struct Update {
    pub mode: Mode,
    #[serde(default)]
    pub networks: Vec<String>,
}

impl WebAccess {
    /// Loads `web-access.json` from the host home. An unreadable file is not
    /// trusted: access stays off until the user saves the page again.
    pub fn load(home: &Path) -> Self {
        let path = home.join(FILE);
        let config = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<Config>(&text).ok())
            .filter(|config| config.schema == SCHEMA)
            .unwrap_or_else(|| Config { schema: SCHEMA, ..Config::default() });
        Self::with(Some(path), config, Box::new(scan_interfaces))
    }

    /// Access off, nothing persisted. Used by tests and by hosts without a home.
    pub fn disabled() -> Self {
        Self::with(None, Config { schema: SCHEMA, ..Config::default() }, Box::new(Vec::new))
    }

    fn with(
        path: Option<PathBuf>,
        config: Config,
        scan: Box<dyn Fn() -> Vec<Interface> + Send + Sync>,
    ) -> Self {
        let (changes, _) = watch::channel(0);
        Self {
            path,
            inner: Mutex::new(Inner {
                config,
                pairing: None,
                seen_written: HashMap::new(),
                failures: HashMap::new(),
                serving: Vec::new(),
            }),
            changes,
            scan,
        }
    }

    #[cfg(test)]
    pub(crate) fn for_test(
        mode: Mode,
        port: u16,
        networks: &[&str],
        scan: Vec<Interface>,
    ) -> Self {
        Self::with(
            None,
            Config {
                schema: SCHEMA,
                mode,
                port,
                networks: networks.iter().map(|name| name.to_string()).collect(),
                devices: Vec::new(),
            },
            Box::new(move || scan.clone()),
        )
    }

    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }

    fn changed(&self) {
        self.changes.send_modify(|value| *value += 1);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poison| poison.into_inner())
    }

    fn save(&self, config: &Config) -> Result<(), String> {
        let Some(path) = &self.path else { return Ok(()) };
        let text = serde_json::to_vec_pretty(config).map_err(|error| error.to_string())?;
        let temp = path.with_extension("json.tmp");
        std::fs::write(&temp, text).map_err(|error| format!("cannot write web access settings: {error}"))?;
        std::fs::rename(&temp, path).map_err(|error| format!("cannot write web access settings: {error}"))
    }

    pub fn interfaces(&self) -> Vec<Interface> {
        (self.scan)()
    }

    /// The addresses web listeners should serve right now.
    pub fn desired(&self) -> Vec<SocketAddr> {
        let (mode, port, networks) = {
            let inner = self.lock();
            (inner.config.mode, inner.config.port, inner.config.networks.clone())
        };
        if mode == Mode::Off || port == 0 {
            return Vec::new();
        }
        let mut addresses = vec![SocketAddr::from((Ipv4Addr::LOCALHOST, port))];
        if mode == Mode::Networks {
            for interface in self.interfaces() {
                if networks.contains(&interface.name) {
                    let address = SocketAddr::new(interface.address, port);
                    if !addresses.contains(&address) {
                        addresses.push(address);
                    }
                }
            }
        }
        addresses
    }

    pub(crate) fn set_serving(&self, serving: Vec<SocketAddr>, failures: HashMap<SocketAddr, String>) {
        let mut inner = self.lock();
        let changed = inner.serving != serving;
        inner.serving = serving;
        inner.failures = failures;
        drop(inner);
        if changed {
            self.changed();
        }
    }

    /// Whether a connection from `peer` that arrived on `local` may be served.
    pub fn peer_allowed(&self, local: SocketAddr, peer: IpAddr) -> bool {
        if !self.lock().serving.contains(&local) {
            return false;
        }
        let local_ip = unmap(local.ip());
        let peer = unmap(peer);
        if local_ip.is_loopback() {
            return peer.is_loopback();
        }
        let networks = self.lock().config.networks.clone();
        self.interfaces().iter().any(|interface| {
            interface.address == local_ip
                && networks.contains(&interface.name)
                && match interface.kind {
                    NetworkKind::Lan => in_prefix(peer, interface.address, interface.prefix),
                    NetworkKind::Tailnet => is_tailnet(peer),
                }
        })
    }

    /// The Host header values a web listener on `local` answers to.
    pub fn host_allowed(local: SocketAddr, host: &str) -> bool {
        let host = host.to_ascii_lowercase();
        let port = local.port();
        let ip = unmap(local.ip());
        if host == authority(ip, port) {
            return true;
        }
        ip.is_loopback() && host == format!("localhost:{port}")
    }

    pub fn origin_allowed(local: SocketAddr, origin: &str) -> bool {
        let origin = origin.to_ascii_lowercase();
        origin
            .strip_prefix("http://")
            .is_some_and(|rest| Self::host_allowed(local, rest))
    }

    /// Resolves a device cookie to a device id, if that device may use this
    /// listener from this peer.
    pub fn authorize(&self, cookie: &str, local: SocketAddr, peer: IpAddr) -> Option<String> {
        if !self.peer_allowed(local, peer) {
            return None;
        }
        let (id, secret) = cookie.split_once('.')?;
        let hash = sha256(secret);
        let now = Instant::now();
        let mut inner = self.lock();
        let device = inner.config.devices.iter_mut().find(|device| device.id == id)?;
        if !constant_eq(device.hash.as_bytes(), hash.as_bytes()) {
            return None;
        }
        device.last_seen = Some(timestamp());
        let id = device.id.clone();
        let write = inner
            .seen_written
            .get(&id)
            .is_none_or(|last| now.duration_since(*last) >= SEEN_WRITE_INTERVAL);
        if write {
            inner.seen_written.insert(id.clone(), now);
            let config = inner.config.clone();
            drop(inner);
            let _ = self.save(&config);
        }
        Some(id)
    }

    /// Whether an already-authorized request may keep its stream open.
    pub fn still_allowed(&self, device: &str, local: SocketAddr, peer: IpAddr) -> bool {
        self.peer_allowed(local, peer)
            && self.lock().config.devices.iter().any(|item| item.id == device)
    }

    /// Creates a new pairing code, replacing any earlier one.
    pub fn start_pairing(&self) -> Result<(String, Duration), String> {
        let mut inner = self.lock();
        if inner.config.mode == Mode::Off {
            return Err("Turn on web access before pairing a device".into());
        }
        if inner.config.devices.len() >= MAX_DEVICES {
            return Err("Too many paired devices; remove one first".into());
        }
        let code = pairing_code();
        inner.pairing = Some(Pairing {
            hash: sha256(&code),
            expires: Instant::now() + PAIRING_LIFETIME,
            attempts: 0,
        });
        Ok((code, PAIRING_LIFETIME))
    }

    pub fn cancel_pairing(&self) {
        self.lock().pairing = None;
    }

    /// Exchanges a pairing code for a device credential (`<id>.<secret>`).
    /// The code works once; a few wrong codes cancel it.
    pub fn complete_pairing(
        &self,
        code: &str,
        name: &str,
        local: SocketAddr,
        peer: IpAddr,
    ) -> Result<(String, String), PairingError> {
        if !self.peer_allowed(local, peer) {
            return Err(PairingError::Refused);
        }
        let code = normalize_code(code);
        let mut inner = self.lock();
        let Some(pairing) = inner.pairing.as_mut() else {
            return Err(PairingError::NoPairing);
        };
        if Instant::now() >= pairing.expires {
            inner.pairing = None;
            return Err(PairingError::Expired);
        }
        if !constant_eq(pairing.hash.as_bytes(), sha256(&code).as_bytes()) {
            pairing.attempts += 1;
            if pairing.attempts >= PAIRING_ATTEMPTS {
                inner.pairing = None;
                return Err(PairingError::TooManyAttempts);
            }
            return Err(PairingError::WrongCode);
        }
        inner.pairing = None;
        let id = random_hex(8);
        let secret = random_hex(32);
        let network = self.network_label(local);
        inner.config.devices.push(Device {
            id: id.clone(),
            name: name.to_string(),
            hash: sha256(&secret),
            network: network.clone(),
            created_at: timestamp(),
            last_seen: Some(timestamp()),
        });
        let config = inner.config.clone();
        drop(inner);
        if let Err(error) = self.save(&config) {
            // A device that cannot be persisted would silently vanish on restart.
            self.lock().config.devices.retain(|device| device.id != id);
            return Err(PairingError::Storage(error));
        }
        self.changed();
        Ok((format!("{id}.{secret}"), network))
    }

    fn network_label(&self, local: SocketAddr) -> String {
        let ip = unmap(local.ip());
        if ip.is_loopback() {
            return "This computer".into();
        }
        self.interfaces()
            .into_iter()
            .find(|interface| interface.address == ip)
            .map(|interface| interface.name)
            .unwrap_or_else(|| ip.to_string())
    }

    pub fn revoke(&self, id: Option<&str>) -> Result<bool, String> {
        let mut inner = self.lock();
        let before = inner.config.devices.len();
        match id {
            Some(id) => inner.config.devices.retain(|device| device.id != id),
            None => inner.config.devices.clear(),
        }
        let removed = inner.config.devices.len() != before;
        let config = inner.config.clone();
        drop(inner);
        if removed {
            self.save(&config)?;
            self.changed();
        }
        Ok(removed)
    }

    /// Applies a new scope. Returns an error for networks that are not
    /// trusted interfaces on this computer.
    pub fn update(&self, update: Update) -> Result<(), String> {
        let interfaces = self.interfaces();
        let mut networks = Vec::new();
        if update.mode == Mode::Networks {
            for name in update.networks {
                if !interfaces.iter().any(|interface| interface.name == name) {
                    return Err(format!("{name} is not a trusted network on this computer"));
                }
                if !networks.contains(&name) {
                    networks.push(name);
                }
            }
            if networks.is_empty() {
                return Err("Choose at least one trusted network".into());
            }
        }
        let mut inner = self.lock();
        inner.config.mode = update.mode;
        if update.mode == Mode::Networks || update.mode == Mode::Off {
            inner.config.networks = networks;
        }
        if update.mode != Mode::Off && inner.config.port == 0 {
            inner.config.port = free_port().ok_or("No free port for web access")?;
        }
        if update.mode == Mode::Off {
            inner.pairing = None;
        }
        let config = inner.config.clone();
        drop(inner);
        self.save(&config)?;
        self.changed();
        Ok(())
    }

    pub fn mode(&self) -> Mode {
        self.lock().config.mode
    }

    /// Scope names for `/v1/capabilities`, as seen from a listener.
    pub fn scopes(&self, listener: Listener) -> Vec<&'static str> {
        match listener {
            Listener::Internal => vec!["loopback"],
            Listener::Web { local } => {
                let ip = unmap(local.ip());
                if ip.is_loopback() {
                    vec!["loopback"]
                } else if is_tailnet(ip) {
                    vec!["tailnet"]
                } else {
                    vec!["lan"]
                }
            }
        }
    }

    /// The settings page snapshot. Never contains a credential.
    pub fn snapshot(&self) -> Value {
        let interfaces = self.interfaces();
        let inner = self.lock();
        let config = &inner.config;
        let port = config.port;
        let serving = inner.serving.clone();
        let networks: Vec<Value> = interfaces
            .iter()
            .map(|interface| {
                let address = SocketAddr::new(interface.address, port);
                json!({
                    "name": interface.name,
                    "address": interface.address.to_string(),
                    "kind": interface.kind,
                    "enabled": config.mode == Mode::Networks && config.networks.contains(&interface.name),
                    "url": (port != 0 && serving.contains(&address)).then(|| format!("http://{}/", authority(interface.address, port))),
                    "error": inner.failures.get(&address),
                })
            })
            .collect();
        let missing: Vec<&String> = config
            .networks
            .iter()
            .filter(|name| !interfaces.iter().any(|interface| &interface.name == *name))
            .collect();
        let local = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
        json!({
            "mode": config.mode,
            "port": (port != 0).then_some(port),
            "secure": false,
            "localUrl": (port != 0 && serving.contains(&local)).then(|| format!("http://127.0.0.1:{port}/")),
            "localError": inner.failures.get(&local),
            "networks": networks,
            "unavailableNetworks": missing,
            "devices": config.devices.iter().map(|device| json!({
                "id": device.id,
                "name": device.name,
                "network": device.network,
                "createdAt": device.created_at,
                "lastSeen": device.last_seen,
            })).collect::<Vec<_>>(),
            "pairing": inner.pairing.as_ref().filter(|pairing| Instant::now() < pairing.expires).is_some(),
        })
    }

    /// Pairing links for every address being served.
    pub fn pairing_urls(&self, code: &str) -> Vec<Value> {
        let inner = self.lock();
        inner
            .serving
            .iter()
            .map(|address| {
                let ip = unmap(address.ip());
                let label = if ip.is_loopback() {
                    "This computer".to_string()
                } else {
                    self.network_name_unlocked(ip).unwrap_or_else(|| ip.to_string())
                };
                json!({
                    "network": label,
                    "url": format!("http://{}/pair?code={code}", authority(ip, address.port())),
                })
            })
            .collect()
    }

    fn network_name_unlocked(&self, ip: IpAddr) -> Option<String> {
        self.interfaces()
            .into_iter()
            .find(|interface| interface.address == ip)
            .map(|interface| interface.name)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum PairingError {
    Refused,
    NoPairing,
    Expired,
    WrongCode,
    TooManyAttempts,
    Storage(String),
}

impl PairingError {
    pub fn message(&self) -> String {
        match self {
            Self::Refused => "This device is not on a network Jouzu allows.".into(),
            Self::NoPairing => "No pairing is in progress. Start pairing in Jouzu Desktop: Settings, Web access.".into(),
            Self::Expired => "This pairing code has expired. Start pairing again in Jouzu Desktop.".into(),
            Self::WrongCode => "The pairing code is not correct.".into(),
            Self::TooManyAttempts => "Too many wrong codes. Start pairing again in Jouzu Desktop.".into(),
            Self::Storage(error) => error.clone(),
        }
    }
}

/// Lists interfaces with a private address that can be offered as trusted
/// networks. Loopback, public and link-local addresses are left out.
pub fn scan_interfaces() -> Vec<Interface> {
    let Ok(list) = if_addrs::get_if_addrs() else {
        return Vec::new();
    };
    let mut interfaces = Vec::new();
    for item in list {
        if item.is_loopback() {
            continue;
        }
        let (address, prefix) = match &item.addr {
            if_addrs::IfAddr::V4(v4) => (IpAddr::V4(v4.ip), v4.prefixlen),
            if_addrs::IfAddr::V6(v6) => (IpAddr::V6(v6.ip), v6.prefixlen),
        };
        let Some(kind) = classify(address, &item.name) else { continue };
        let name = if interfaces.iter().any(|existing: &Interface| existing.name == item.name) {
            format!("{} ({address})", item.name)
        } else {
            item.name.clone()
        };
        interfaces.push(Interface { name, address, prefix, kind });
    }
    interfaces
}

/// Private ranges only: RFC 1918, CGNAT (Tailscale), IPv6 ULA (Tailscale's
/// fd7a:115c:a1e0::/48 counts as tailnet).
pub fn classify(address: IpAddr, _name: &str) -> Option<NetworkKind> {
    match unmap(address) {
        IpAddr::V4(v4) => {
            if is_tailnet(IpAddr::V4(v4)) {
                Some(NetworkKind::Tailnet)
            } else if v4.is_private() {
                Some(NetworkKind::Lan)
            } else {
                None
            }
        }
        IpAddr::V6(v6) => {
            if is_tailnet(IpAddr::V6(v6)) {
                Some(NetworkKind::Tailnet)
            } else if (v6.segments()[0] & 0xfe00) == 0xfc00 {
                Some(NetworkKind::Lan)
            } else {
                None
            }
        }
    }
}

pub fn is_tailnet(address: IpAddr) -> bool {
    match unmap(address) {
        IpAddr::V4(v4) => in_prefix(IpAddr::V4(v4), IpAddr::V4(Ipv4Addr::new(100, 64, 0, 0)), 10),
        IpAddr::V6(v6) => in_prefix(
            IpAddr::V6(v6),
            IpAddr::V6(Ipv6Addr::new(0xfd7a, 0x115c, 0xa1e0, 0, 0, 0, 0, 0)),
            48,
        ),
    }
}

pub fn in_prefix(address: IpAddr, network: IpAddr, prefix: u8) -> bool {
    match (unmap(address), unmap(network)) {
        (IpAddr::V4(a), IpAddr::V4(n)) => {
            let prefix = prefix.min(32) as u32;
            let mask = if prefix == 0 { 0 } else { u32::MAX << (32 - prefix) };
            (u32::from(a) & mask) == (u32::from(n) & mask)
        }
        (IpAddr::V6(a), IpAddr::V6(n)) => {
            let prefix = prefix.min(128) as u32;
            let mask = if prefix == 0 { 0 } else { u128::MAX << (128 - prefix) };
            (u128::from(a) & mask) == (u128::from(n) & mask)
        }
        _ => false,
    }
}

fn unmap(address: IpAddr) -> IpAddr {
    match address {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(IpAddr::V6(v6)),
        other => other,
    }
}

fn authority(ip: IpAddr, port: u16) -> String {
    match ip {
        IpAddr::V4(v4) => format!("{v4}:{port}"),
        IpAddr::V6(v6) => format!("[{v6}]:{port}"),
    }
}

fn free_port() -> Option<u16> {
    std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .ok()?
        .local_addr()
        .ok()
        .map(|address| address.port())
}

fn sha256(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    rand::rngs::OsRng.fill_bytes(&mut buffer);
    hex::encode(buffer)
}

/// Eight characters from an alphabet without look-alikes (no 0/O, 1/I/L).
fn pairing_code() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    let mut buffer = [0u8; 8];
    rand::rngs::OsRng.fill_bytes(&mut buffer);
    buffer
        .iter()
        .map(|byte| ALPHABET[*byte as usize % ALPHABET.len()] as char)
        .collect()
}

fn normalize_code(code: &str) -> String {
    code.chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .map(|ch| ch.to_ascii_uppercase())
        .collect()
}

fn timestamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// A short device name from the browser's User-Agent ("Chrome on Android").
pub fn device_name(user_agent: Option<&str>) -> String {
    let Some(agent) = user_agent else { return "Browser".into() };
    let browser = if agent.contains("Edg/") {
        "Edge"
    } else if agent.contains("Firefox/") {
        "Firefox"
    } else if agent.contains("Chrome/") || agent.contains("CriOS/") {
        "Chrome"
    } else if agent.contains("Safari/") {
        "Safari"
    } else {
        "Browser"
    };
    let system = if agent.contains("iPhone") {
        "iPhone"
    } else if agent.contains("iPad") {
        "iPad"
    } else if agent.contains("Android") {
        "Android"
    } else if agent.contains("Windows") {
        "Windows"
    } else if agent.contains("Mac OS X") || agent.contains("Macintosh") {
        "macOS"
    } else if agent.contains("Linux") {
        "Linux"
    } else {
        return browser.into();
    };
    format!("{browser} on {system}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lan() -> Interface {
        Interface {
            name: "Wi-Fi".into(),
            address: "192.168.1.20".parse().unwrap(),
            prefix: 24,
            kind: NetworkKind::Lan,
        }
    }

    fn tailscale() -> Interface {
        Interface {
            name: "Tailscale".into(),
            address: "100.101.102.103".parse().unwrap(),
            prefix: 32,
            kind: NetworkKind::Tailnet,
        }
    }

    fn serve(access: &WebAccess) {
        access.set_serving(access.desired(), HashMap::new());
    }

    #[test]
    fn only_private_ranges_are_offered() {
        assert_eq!(classify("192.168.1.2".parse().unwrap(), ""), Some(NetworkKind::Lan));
        assert_eq!(classify("10.0.0.2".parse().unwrap(), ""), Some(NetworkKind::Lan));
        assert_eq!(classify("172.20.0.2".parse().unwrap(), ""), Some(NetworkKind::Lan));
        assert_eq!(classify("100.100.1.1".parse().unwrap(), ""), Some(NetworkKind::Tailnet));
        assert_eq!(classify("fd7a:115c:a1e0::1".parse().unwrap(), ""), Some(NetworkKind::Tailnet));
        assert_eq!(classify("fd00::1".parse().unwrap(), ""), Some(NetworkKind::Lan));
        assert_eq!(classify("8.8.8.8".parse().unwrap(), ""), None);
        assert_eq!(classify("2001:db8::1".parse().unwrap(), ""), None);
        assert_eq!(classify("169.254.1.1".parse().unwrap(), ""), None);
        assert_eq!(classify("0.0.0.0".parse().unwrap(), ""), None);
    }

    #[test]
    fn off_serves_nothing_and_local_serves_only_loopback() {
        let access = WebAccess::for_test(Mode::Off, 50000, &["Wi-Fi"], vec![lan()]);
        assert!(access.desired().is_empty());
        let access = WebAccess::for_test(Mode::Local, 50000, &["Wi-Fi"], vec![lan()]);
        assert_eq!(access.desired(), vec!["127.0.0.1:50000".parse().unwrap()]);
    }

    #[test]
    fn networks_serve_only_enabled_interfaces() {
        let access = WebAccess::for_test(Mode::Networks, 50000, &["Tailscale"], vec![lan(), tailscale()]);
        assert_eq!(
            access.desired(),
            vec!["127.0.0.1:50000".parse().unwrap(), "100.101.102.103:50000".parse().unwrap()]
        );
    }

    #[test]
    fn peers_must_come_from_the_enabled_network() {
        let access = WebAccess::for_test(Mode::Networks, 50000, &["Wi-Fi", "Tailscale"], vec![lan(), tailscale()]);
        serve(&access);
        let wifi: SocketAddr = "192.168.1.20:50000".parse().unwrap();
        let tail: SocketAddr = "100.101.102.103:50000".parse().unwrap();
        let local: SocketAddr = "127.0.0.1:50000".parse().unwrap();
        assert!(access.peer_allowed(wifi, "192.168.1.55".parse().unwrap()));
        assert!(!access.peer_allowed(wifi, "192.168.2.55".parse().unwrap()));
        assert!(!access.peer_allowed(wifi, "8.8.8.8".parse().unwrap()));
        assert!(access.peer_allowed(tail, "100.64.0.9".parse().unwrap()));
        assert!(!access.peer_allowed(tail, "192.168.1.55".parse().unwrap()));
        assert!(access.peer_allowed(local, "127.0.0.1".parse().unwrap()));
        assert!(!access.peer_allowed(local, "192.168.1.55".parse().unwrap()));
        // A listener the host is not serving any more refuses everyone.
        assert!(!access.peer_allowed("192.168.1.20:50001".parse().unwrap(), "192.168.1.55".parse().unwrap()));
    }

    #[test]
    fn host_header_must_name_the_listener() {
        let wifi: SocketAddr = "192.168.1.20:50000".parse().unwrap();
        assert!(WebAccess::host_allowed(wifi, "192.168.1.20:50000"));
        assert!(!WebAccess::host_allowed(wifi, "evil.example:50000"));
        assert!(!WebAccess::host_allowed(wifi, "localhost:50000"));
        let local: SocketAddr = "127.0.0.1:50000".parse().unwrap();
        assert!(WebAccess::host_allowed(local, "localhost:50000"));
        assert!(WebAccess::origin_allowed(wifi, "http://192.168.1.20:50000"));
        assert!(!WebAccess::origin_allowed(wifi, "http://evil.example"));
    }

    #[test]
    fn pairing_is_single_use_and_the_credential_is_hashed() {
        let access = WebAccess::for_test(Mode::Local, 50000, &[], vec![]);
        serve(&access);
        let local: SocketAddr = "127.0.0.1:50000".parse().unwrap();
        let peer: IpAddr = "127.0.0.1".parse().unwrap();
        let (code, _) = access.start_pairing().unwrap();
        let (credential, _) = access.complete_pairing(&code.to_lowercase(), "Chrome on Windows", local, peer).unwrap();
        assert_eq!(
            access.complete_pairing(&code, "again", local, peer),
            Err(PairingError::NoPairing)
        );
        let id = access.authorize(&credential, local, peer).expect("paired device");
        let stored = serde_json::to_string(&access.lock().config).unwrap();
        let secret = credential.split_once('.').unwrap().1;
        assert!(!stored.contains(secret), "the secret must not be stored");
        assert!(access.authorize(&format!("{id}.wrong"), local, peer).is_none());
        assert!(!access.snapshot().to_string().contains(secret));
    }

    #[test]
    fn wrong_codes_cancel_the_pairing() {
        let access = WebAccess::for_test(Mode::Local, 50000, &[], vec![]);
        serve(&access);
        let local: SocketAddr = "127.0.0.1:50000".parse().unwrap();
        let peer: IpAddr = "127.0.0.1".parse().unwrap();
        let (code, _) = access.start_pairing().unwrap();
        for _ in 0..PAIRING_ATTEMPTS - 1 {
            assert_eq!(access.complete_pairing("WRONGCDE", "x", local, peer), Err(PairingError::WrongCode));
        }
        assert_eq!(access.complete_pairing("WRONGCDE", "x", local, peer), Err(PairingError::TooManyAttempts));
        assert_eq!(access.complete_pairing(&code, "x", local, peer), Err(PairingError::NoPairing));
    }

    #[test]
    fn pairing_needs_access_on_and_a_trusted_peer() {
        let access = WebAccess::for_test(Mode::Off, 50000, &[], vec![]);
        assert!(access.start_pairing().is_err());
        let access = WebAccess::for_test(Mode::Local, 50000, &[], vec![]);
        serve(&access);
        let (code, _) = access.start_pairing().unwrap();
        assert_eq!(
            access.complete_pairing(&code, "x", "127.0.0.1:50000".parse().unwrap(), "192.168.1.5".parse().unwrap()),
            Err(PairingError::Refused)
        );
    }

    #[test]
    fn revoke_and_scope_changes_end_access() {
        let access = WebAccess::for_test(Mode::Networks, 50000, &["Wi-Fi"], vec![lan()]);
        serve(&access);
        let wifi: SocketAddr = "192.168.1.20:50000".parse().unwrap();
        let peer: IpAddr = "192.168.1.55".parse().unwrap();
        let (code, _) = access.start_pairing().unwrap();
        let (credential, network) = access.complete_pairing(&code, "Safari on iPhone", wifi, peer).unwrap();
        assert_eq!(network, "Wi-Fi");
        let id = access.authorize(&credential, wifi, peer).unwrap();
        let mut changes = access.subscribe();
        changes.mark_unchanged();
        access.update(Update { mode: Mode::Local, networks: vec![] }).unwrap();
        serve(&access);
        assert!(changes.has_changed().unwrap());
        assert!(!access.still_allowed(&id, wifi, peer));
        assert!(access.authorize(&credential, wifi, peer).is_none());

        let local: SocketAddr = "127.0.0.1:50000".parse().unwrap();
        let loopback: IpAddr = "127.0.0.1".parse().unwrap();
        assert!(access.still_allowed(&id, local, loopback));
        assert!(access.revoke(Some(&id)).unwrap());
        assert!(!access.still_allowed(&id, local, loopback));
        assert!(access.authorize(&credential, local, loopback).is_none());
    }

    #[test]
    fn networks_must_exist_and_be_chosen() {
        let access = WebAccess::for_test(Mode::Off, 0, &[], vec![lan()]);
        assert!(access.update(Update { mode: Mode::Networks, networks: vec![] }).is_err());
        assert!(access.update(Update { mode: Mode::Networks, networks: vec!["Ethernet 9".into()] }).is_err());
        access.update(Update { mode: Mode::Networks, networks: vec!["Wi-Fi".into()] }).unwrap();
        assert_ne!(access.lock().config.port, 0, "enabling picks a persistent port");
    }

    #[test]
    fn settings_survive_a_restart() {
        let home = tempfile::tempdir().unwrap();
        let access = WebAccess::load(home.path());
        assert_eq!(access.mode(), Mode::Off);
        access.update(Update { mode: Mode::Local, networks: vec![] }).unwrap();
        let port = access.lock().config.port;
        let again = WebAccess::load(home.path());
        assert_eq!(again.mode(), Mode::Local);
        assert_eq!(again.lock().config.port, port);
        std::fs::write(home.path().join(FILE), "not json").unwrap();
        assert_eq!(WebAccess::load(home.path()).mode(), Mode::Off);
    }

    #[test]
    fn device_names_are_readable() {
        assert_eq!(
            device_name(Some("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1")),
            "Safari on iPhone"
        );
        assert_eq!(
            device_name(Some("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 Edg/120.0")),
            "Edge on Windows"
        );
        assert_eq!(device_name(None), "Browser");
    }
}
