//! Stable C ABI used by the native iOS application.
//!
//! The Swift process hosts the same Rust daemon as the desktop binary. Calls are
//! JSON to keep the ABI small and versionable; the authenticated control socket
//! remains an implementation detail inside the app sandbox.

use std::{
    collections::{BTreeSet, HashMap, HashSet},
    ffi::{CStr, CString, c_char},
    net::SocketAddr,
    path::{Path, PathBuf},
    ptr,
    str::FromStr,
    sync::{
        Arc, LazyLock, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use anyhow::{Context, Result, anyhow};
use libp2p::{Multiaddr, PeerId};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    identity, ipc,
    mailbox::Mailbox,
    membership::{JoinHint, JoinTicket, MembershipManager},
    model::{AgentCapabilities, LeaderCapabilities, NodeRole},
    network::{self, DaemonOptions, NodeOptions},
    store::ObjectStore,
};

static NEXT_HANDLE: AtomicU64 = AtomicU64::new(1);
static NODES: LazyLock<Mutex<HashMap<u64, MobileNode>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

struct MobileNode {
    state_dir: PathBuf,
    thread: Option<JoinHandle<()>>,
}

#[derive(Debug, Clone, Deserialize)]
struct MobileConfig {
    state_dir: PathBuf,
    #[serde(default = "default_name")]
    name: String,
    #[serde(default)]
    network_id: Option<String>,
    #[serde(default)]
    join_code: Option<String>,
    #[serde(default)]
    listen: Vec<String>,
    #[serde(default)]
    bootstrap: Vec<String>,
    #[serde(default)]
    allow_peers: Vec<String>,
    #[serde(default)]
    allow_all_peers: bool,
    #[serde(default = "default_region")]
    region: String,
    #[serde(default = "default_zone")]
    zone: String,
    #[serde(default = "default_currency")]
    currency: String,
    #[serde(default)]
    private_networks: Vec<String>,
    #[serde(default = "default_storage")]
    storage_free_bytes: u64,
    #[serde(default = "default_bandwidth")]
    ingress_mbps: f64,
    #[serde(default = "default_bandwidth")]
    egress_mbps: f64,
    #[serde(default)]
    roles: Vec<String>,
    #[serde(default)]
    workspaces: Vec<String>,
    #[serde(default = "default_parallel_tasks")]
    max_parallel_tasks: u16,
    #[serde(default)]
    leader_enabled: bool,
}

fn default_name() -> String {
    "iPhone Watcher".into()
}

fn default_region() -> String {
    "mobile".into()
}

fn default_zone() -> String {
    "ios".into()
}

fn default_currency() -> String {
    "CNY".into()
}

fn default_storage() -> u64 {
    10 * 1024 * 1024 * 1024
}

fn default_bandwidth() -> f64 {
    100.0
}

fn default_parallel_tasks() -> u16 {
    1
}

impl MobileConfig {
    fn join_code(&self) -> Option<String> {
        self.join_code
            .as_deref()
            .filter(|code| !code.trim().is_empty())
            .map(str::trim)
            .map(str::to_owned)
    }

    fn node_options(&self, ticket: Option<&JoinTicket>) -> Result<NodeOptions> {
        std::fs::create_dir_all(&self.state_dir)?;
        let keypair = identity::load_or_create(&self.state_dir.join("identity.key"))?;
        let persisted = MembershipManager::load(&self.state_dir)?;
        let network_id = ticket
            .map(|ticket| ticket.network_id.clone())
            .or_else(|| self.network_id.clone())
            .or_else(|| persisted.as_ref().map(|state| state.network_id.clone()))
            .unwrap_or_else(|| "default".into());
        let bootstrap = if let Some(ticket) = ticket {
            ticket.bootstrap_addrs()?
        } else if !self.bootstrap.is_empty() {
            parse_multiaddrs(&self.bootstrap)?
        } else {
            persisted
                .as_ref()
                .map(|state| parse_multiaddrs(&state.bootstrap))
                .transpose()?
                .unwrap_or_default()
        };
        let listen = if self.listen.is_empty() {
            vec![
                Multiaddr::from_str("/ip4/0.0.0.0/tcp/0")?,
                Multiaddr::from_str("/ip4/0.0.0.0/udp/0/quic-v1")?,
            ]
        } else {
            parse_multiaddrs(&self.listen)?
        };
        let allowed_peers = self
            .allow_peers
            .iter()
            .map(|peer| {
                peer.parse::<PeerId>()
                    .with_context(|| format!("invalid peer ID {peer}"))
            })
            .collect::<Result<HashSet<_>>>()?;
        let roles = if self.roles.is_empty() {
            BTreeSet::from(["general".into(), "mobile".into()])
        } else {
            self.roles.iter().cloned().collect()
        };
        let leader = LeaderCapabilities {
            protocols: BTreeSet::from(["dsh-leader/1".into()]),
            roles,
            workspace_aliases: self.workspaces.iter().cloned().collect(),
            team_enabled: true,
            max_parallel_tasks: self.max_parallel_tasks.max(1),
        };
        let capabilities = AgentCapabilities {
            node_role: if self.leader_enabled {
                NodeRole::Leader
            } else {
                NodeRole::Watcher
            },
            region: self.region.clone(),
            zone: self.zone.clone(),
            currency: self.currency.clone(),
            private_networks: self.private_networks.iter().cloned().collect(),
            storage_free_bytes: self.storage_free_bytes,
            ingress_mbps: self.ingress_mbps,
            egress_mbps: self.egress_mbps,
            load: 0.0,
            idle_price_per_gib: 0.0,
            busy_price_per_gib: 0.0,
            idle_start_hour: 0,
            idle_end_hour: 8,
            utc_offset_minutes: 480,
            relay: false,
            leader: self.leader_enabled.then_some(leader),
        };
        let membership =
            MembershipManager::open(&self.state_dir, &network_id, keypair.public().to_peer_id())?;
        Ok(NodeOptions {
            keypair,
            network_id,
            name: self.name.clone(),
            listen,
            bootstrap,
            capabilities,
            store: ObjectStore::open(self.state_dir.join("store"))?,
            mailbox: Mailbox::open(self.state_dir.join("mailbox"))?,
            allowed_peers,
            allow_all_peers: self.allow_all_peers,
            membership,
        })
    }
}

fn parse_multiaddrs(values: &[String]) -> Result<Vec<Multiaddr>> {
    values
        .iter()
        .map(|value| {
            value
                .parse()
                .with_context(|| format!("invalid multiaddress {value}"))
        })
        .collect()
}

fn runtime() -> Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .worker_threads(2)
        .thread_name("agent-mesh-ios")
        .build()
        .map_err(Into::into)
}

fn call_sync(state_dir: &Path, method: &str, params: Value) -> Result<Value> {
    runtime()?.block_on(ipc::call(state_dir, method, params))
}

fn start(config: MobileConfig) -> Result<Value> {
    if config.state_dir.as_os_str().is_empty() {
        return Err(anyhow!("state_dir is required"));
    }
    if NODES
        .lock()
        .map_err(|_| anyhow!("mobile node registry is poisoned"))?
        .values()
        .any(|node| node.state_dir == config.state_dir)
    {
        return Err(anyhow!("this state directory already has a running node"));
    }
    let _ = std::fs::remove_file(config.state_dir.join("control.json"));
    let join_code = config.join_code();
    let error = Arc::new(Mutex::new(None::<String>));
    let finished = Arc::new(AtomicBool::new(false));
    let thread_error = Arc::clone(&error);
    let thread_finished = Arc::clone(&finished);
    let thread_config = config.clone();
    let state_dir = config.state_dir.clone();
    let thread = thread::Builder::new()
        .name("agent-mesh-ios-host".into())
        .spawn(move || {
            let result = (|| -> Result<()> {
                let runtime = runtime()?;
                runtime.block_on(async {
                    let ticket = match join_code.as_deref() {
                        Some(code) if code.starts_with("mesh1h:") => Some(
                            network::resolve_join_hint(
                                identity::load_or_create(
                                    &thread_config.state_dir.join("identity.key"),
                                )?,
                                JoinHint::decode(code)?,
                            )
                            .await?,
                        ),
                        Some(code) => Some(JoinTicket::decode(code)?),
                        None => None,
                    };
                    if let Some(ticket) = ticket.as_ref()
                        && MembershipManager::load(&thread_config.state_dir)?.is_none()
                    {
                        network::join(thread_config.node_options(Some(ticket))?, ticket.clone())
                            .await?;
                    }
                    network::daemon(DaemonOptions {
                        node: thread_config.node_options(None)?,
                        state_dir: thread_config.state_dir.clone(),
                        control_listen: "127.0.0.1:0".parse::<SocketAddr>()?,
                        allow_source_delete: false,
                    })
                    .await
                })
            })();
            if let Err(cause) = result
                && let Ok(mut slot) = thread_error.lock()
            {
                *slot = Some(format!("{cause:#}"));
            }
            thread_finished.store(true, Ordering::Release);
        })?;

    let deadline = Instant::now() + Duration::from_secs(15);
    let status = loop {
        if let Ok(status) = call_sync(&state_dir, "status", json!({})) {
            break status;
        }
        if finished.load(Ordering::Acquire) {
            let cause = error
                .lock()
                .ok()
                .and_then(|slot| slot.clone())
                .unwrap_or_else(|| "mesh node stopped during startup".into());
            let _ = thread.join();
            return Err(anyhow!(cause));
        }
        if Instant::now() >= deadline {
            return Err(anyhow!("mesh node did not become ready within 15 seconds"));
        }
        thread::sleep(Duration::from_millis(100));
    };
    let handle = NEXT_HANDLE.fetch_add(1, Ordering::Relaxed);
    NODES
        .lock()
        .map_err(|_| anyhow!("mobile node registry is poisoned"))?
        .insert(
            handle,
            MobileNode {
                state_dir,
                thread: Some(thread),
            },
        );
    Ok(json!({"handle":handle,"status":status}))
}

fn call(handle: u64, method: &str, params: Value) -> Result<Value> {
    let state_dir = NODES
        .lock()
        .map_err(|_| anyhow!("mobile node registry is poisoned"))?
        .get(&handle)
        .map(|node| node.state_dir.clone())
        .ok_or_else(|| anyhow!("unknown mobile node handle {handle}"))?;
    call_sync(&state_dir, method, params)
}

fn stop(handle: u64) -> Result<Value> {
    let mut node = NODES
        .lock()
        .map_err(|_| anyhow!("mobile node registry is poisoned"))?
        .remove(&handle)
        .ok_or_else(|| anyhow!("unknown mobile node handle {handle}"))?;
    let response = call_sync(&node.state_dir, "shutdown", json!({}));
    if let Some(thread) = node.thread.take() {
        thread
            .join()
            .map_err(|_| anyhow!("mesh host thread panicked"))?;
    }
    response
}

fn c_input(pointer: *const c_char, name: &str) -> Result<&str> {
    if pointer.is_null() {
        return Err(anyhow!("{name} cannot be null"));
    }
    // SAFETY: The public C contract requires a valid NUL-terminated string.
    unsafe { CStr::from_ptr(pointer) }
        .to_str()
        .with_context(|| format!("{name} must be UTF-8"))
}

fn c_output(result: Result<Value>) -> *mut c_char {
    let value = match result {
        Ok(result) => json!({"ok":true,"result":result}),
        Err(error) => json!({"ok":false,"error":format!("{error:#}")}),
    };
    CString::new(value.to_string())
        .map(CString::into_raw)
        .unwrap_or(ptr::null_mut())
}

/// Start an embedded node. `config_json` is a UTF-8 JSON object.
#[unsafe(no_mangle)]
pub extern "C" fn agent_mesh_mobile_start(config_json: *const c_char) -> *mut c_char {
    c_output((|| {
        let config = serde_json::from_str::<MobileConfig>(c_input(config_json, "config_json")?)?;
        start(config)
    })())
}

/// Call the embedded node's control API with a JSON object as parameters.
#[unsafe(no_mangle)]
pub extern "C" fn agent_mesh_mobile_call(
    handle: u64,
    method: *const c_char,
    params_json: *const c_char,
) -> *mut c_char {
    c_output((|| {
        let method = c_input(method, "method")?;
        let params = serde_json::from_str::<Value>(c_input(params_json, "params_json")?)?;
        call(handle, method, params)
    })())
}

/// Stop an embedded node and wait for its networking thread to exit.
#[unsafe(no_mangle)]
pub extern "C" fn agent_mesh_mobile_stop(handle: u64) -> *mut c_char {
    c_output(stop(handle))
}

/// Release a string returned by another `agent_mesh_mobile_*` function.
///
/// # Safety
///
/// `value` must be null or an unmodified pointer returned by this library, and
/// it must not have been freed previously.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn agent_mesh_mobile_string_free(value: *mut c_char) {
    if !value.is_null() {
        // SAFETY: This pointer was allocated by CString::into_raw in c_output.
        unsafe {
            drop(CString::from_raw(value));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_defaults_to_watcher_mode() {
        let config: MobileConfig =
            serde_json::from_value(json!({"state_dir":"/tmp/mesh"})).unwrap();
        assert_eq!(config.name, "iPhone Watcher");
        assert!(!config.leader_enabled);
        assert_eq!(config.max_parallel_tasks, 1);
        assert_eq!(config.ingress_mbps, 100.0);
    }

    #[test]
    fn watcher_mode_does_not_advertise_as_a_leader() {
        let config: MobileConfig = serde_json::from_value(json!({
            "state_dir":"/tmp/mesh",
            "leader_enabled":false
        }))
        .unwrap();
        assert!(!config.leader_enabled);
        let options = config.node_options(None).unwrap();
        assert_eq!(options.capabilities.node_role, NodeRole::Watcher);
        assert!(options.capabilities.leader.is_none());
    }

    #[test]
    fn null_c_input_is_rejected() {
        assert!(c_input(ptr::null(), "input").is_err());
    }
}
