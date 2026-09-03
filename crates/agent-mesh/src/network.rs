use std::{
    collections::{HashMap, HashSet},
    net::SocketAddr,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use anyhow::{Result, anyhow, bail};
use chrono::Utc;
use futures::StreamExt;
use libp2p::{
    Multiaddr, PeerId, StreamProtocol, Swarm, SwarmBuilder, gossipsub, identify, identity, kad,
    mdns,
    multiaddr::Protocol,
    noise, ping,
    request_response::{self, OutboundRequestId, ProtocolSupport},
    swarm::{NetworkBehaviour, SwarmEvent},
    tcp, yamux,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    sync::{mpsc, oneshot},
    time::{MissedTickBehavior, interval, timeout},
};
use uuid::Uuid;

use crate::{
    envelope::{Envelope, EnvelopeKind},
    ipc::{ControlFile, RpcRequest, RpcResponse},
    mailbox::Mailbox,
    model::{ADVERTISEMENT_TTL_SECS, AgentAdvertisement, AgentCapabilities, ObjectSummary},
    planner::{Candidate, OptimizeFor, RouteKind, TransferPlan, choose_best},
    protocol::{MeshRequest, MeshResponse, chunk_response},
    store::ObjectStore,
};

const MESH_PROTOCOL: StreamProtocol = StreamProtocol::new("/agent-mesh/transfer/1");

#[derive(NetworkBehaviour)]
struct Behaviour {
    request_response: request_response::cbor::Behaviour<MeshRequest, MeshResponse>,
    kademlia: kad::Behaviour<kad::store::MemoryStore>,
    gossipsub: gossipsub::Behaviour,
    mdns: mdns::tokio::Behaviour,
    identify: identify::Behaviour,
    ping: ping::Behaviour,
}

pub struct NodeOptions {
    pub keypair: identity::Keypair,
    pub network_id: String,
    pub name: String,
    pub listen: Vec<Multiaddr>,
    pub bootstrap: Vec<Multiaddr>,
    pub capabilities: AgentCapabilities,
    pub store: ObjectStore,
    pub mailbox: Mailbox,
    pub allowed_peers: HashSet<PeerId>,
    pub allow_all_peers: bool,
}

struct MeshNode {
    swarm: Swarm<Behaviour>,
    topic: gossipsub::IdentTopic,
    advertisement: AgentAdvertisement,
    store: ObjectStore,
    bootstrap_peers: HashSet<PeerId>,
    served_chunks: HashMap<(PeerId, String), HashSet<u64>>,
    mailbox: Mailbox,
    allowed_peers: HashSet<PeerId>,
    allow_all_peers: bool,
}

#[derive(Debug, Clone)]
pub struct PeerSnapshot {
    pub peer_id: PeerId,
    pub advertisement: AgentAdvertisement,
    pub inventory: Vec<ObjectSummary>,
    pub route: RouteKind,
    pub observed_rtt_ms: f64,
}

#[derive(Debug, Clone, Copy)]
enum PendingKind {
    Advertisement,
    Inventory,
}

impl MeshNode {
    async fn new(options: NodeOptions) -> Result<Self> {
        options
            .capabilities
            .validate()
            .map_err(anyhow::Error::msg)?;
        let peer_id = options.keypair.public().to_peer_id();
        let mut swarm = SwarmBuilder::with_existing_identity(options.keypair)
            .with_tokio()
            .with_tcp(
                tcp::Config::default().nodelay(true),
                noise::Config::new,
                yamux::Config::default,
            )?
            .with_quic()
            .with_dns()?
            .with_behaviour(|key| {
                let gossipsub_config = gossipsub::ConfigBuilder::default()
                    .validation_mode(gossipsub::ValidationMode::Strict)
                    .heartbeat_interval(Duration::from_secs(5))
                    .build()
                    .map_err(std::io::Error::other)?;
                let gossipsub = gossipsub::Behaviour::new(
                    gossipsub::MessageAuthenticity::Signed(key.clone()),
                    gossipsub_config,
                )?;
                Ok(Behaviour {
                    request_response: request_response::cbor::Behaviour::new(
                        [(MESH_PROTOCOL, ProtocolSupport::Full)],
                        request_response::Config::default()
                            .with_request_timeout(Duration::from_secs(20)),
                    ),
                    kademlia: kad::Behaviour::new(peer_id, kad::store::MemoryStore::new(peer_id)),
                    gossipsub,
                    mdns: mdns::tokio::Behaviour::new(mdns::Config::default(), peer_id)?,
                    identify: identify::Behaviour::new(identify::Config::new(
                        "/agent-mesh/id/1".into(),
                        key.public(),
                    )),
                    ping: ping::Behaviour::default(),
                })
            })?
            .with_swarm_config(|config| {
                config.with_idle_connection_timeout(Duration::from_secs(120))
            })
            .build();
        swarm
            .behaviour_mut()
            .kademlia
            .set_mode(Some(kad::Mode::Server));
        if options.network_id.trim().is_empty() {
            bail!("network-id cannot be empty")
        }
        let topic =
            gossipsub::IdentTopic::new(format!("agent-mesh/{}/agents/v1", options.network_id));
        swarm.behaviour_mut().gossipsub.subscribe(&topic)?;
        for address in &options.listen {
            swarm.listen_on(address.clone())?;
        }

        let mut bootstrap_peers = HashSet::new();
        for address in &options.bootstrap {
            let peer = peer_from_multiaddr(address)?;
            bootstrap_peers.insert(peer);
            swarm
                .behaviour_mut()
                .kademlia
                .add_address(&peer, strip_peer(address.clone()));
            swarm.dial(address.clone())?;
        }
        if !bootstrap_peers.is_empty() {
            let _ = swarm.behaviour_mut().kademlia.bootstrap();
        }
        let now = Utc::now();
        Ok(Self {
            swarm,
            topic,
            advertisement: AgentAdvertisement {
                network_id: options.network_id,
                peer_id: peer_id.to_string(),
                agent_name: options.name,
                sequence: 0,
                issued_at: now,
                expires_at: now + chrono::Duration::seconds(ADVERTISEMENT_TTL_SECS),
                capabilities: options.capabilities,
                listen_addresses: vec![],
            },
            store: options.store,
            bootstrap_peers,
            served_chunks: HashMap::new(),
            mailbox: options.mailbox,
            allowed_peers: options.allowed_peers,
            allow_all_peers: options.allow_all_peers,
        })
    }

    fn publish_advertisement(&mut self) {
        let now = Utc::now();
        self.advertisement.sequence = self.advertisement.sequence.saturating_add(1);
        self.advertisement.issued_at = now;
        self.advertisement.expires_at = now + chrono::Duration::seconds(ADVERTISEMENT_TTL_SECS);
        if let Ok(data) = serde_json::to_vec(&self.advertisement) {
            let _ = self
                .swarm
                .behaviour_mut()
                .gossipsub
                .publish(self.topic.clone(), data);
        }
    }

    fn request_peer_snapshot(
        &mut self,
        peer: PeerId,
        pending: &mut HashMap<OutboundRequestId, (PeerId, PendingKind)>,
    ) {
        let advertisement = self
            .swarm
            .behaviour_mut()
            .request_response
            .send_request(&peer, MeshRequest::GetAdvertisement);
        pending.insert(advertisement, (peer, PendingKind::Advertisement));
        let inventory = self
            .swarm
            .behaviour_mut()
            .request_response
            .send_request(&peer, MeshRequest::GetInventory);
        pending.insert(inventory, (peer, PendingKind::Inventory));
    }

    fn add_peer_address(&mut self, peer: PeerId, address: Multiaddr) {
        self.swarm
            .behaviour_mut()
            .kademlia
            .add_address(&peer, strip_peer(address.clone()));
        self.swarm.add_peer_address(peer, strip_peer(address));
    }

    fn provider_key(&self, object_id: &str) -> kad::RecordKey {
        format!("{}:{object_id}", self.advertisement.network_id)
            .into_bytes()
            .into()
    }

    fn handle_inbound_request(
        &mut self,
        peer: PeerId,
        request: MeshRequest,
        channel: request_response::ResponseChannel<MeshResponse>,
        allow_source_delete: bool,
    ) {
        let response = match request {
            MeshRequest::GetAdvertisement => {
                MeshResponse::Advertisement(Box::new(self.advertisement.clone()))
            }
            MeshRequest::GetInventory => match self.store.inventory() {
                Ok(inventory) => MeshResponse::Inventory(inventory),
                Err(error) => MeshResponse::Error {
                    message: error.to_string(),
                },
            },
            MeshRequest::GetChunk { object_id, index } => {
                match (
                    self.store.metadata(&object_id),
                    self.store.read_chunk(&object_id, index),
                ) {
                    (Ok(object), Ok(data)) => {
                        self.served_chunks
                            .entry((peer, object_id.clone()))
                            .or_default()
                            .insert(index);
                        chunk_response(&object, index, data)
                    }
                    (_, Err(error)) | (Err(error), _) => MeshResponse::Error {
                        message: error.to_string(),
                    },
                }
            }
            MeshRequest::TransferReceipt {
                object_id,
                received_sha256,
                request_source_delete,
            } => {
                let metadata = self.store.metadata(&object_id).ok();
                let all_chunks_served = metadata.as_ref().is_some_and(|object| {
                    self.served_chunks
                        .get(&(peer, object_id.clone()))
                        .is_some_and(|chunks| {
                            chunks.len() as u64 == object.chunk_count
                                && (0..object.chunk_count).all(|index| chunks.contains(&index))
                        })
                });
                let valid = object_id == received_sha256 && metadata.is_some() && all_chunks_served;
                let delete_pending = valid
                    && request_source_delete
                    && allow_source_delete
                    && self.store.schedule_delete(&object_id).is_ok();
                if delete_pending {
                    self.served_chunks.remove(&(peer, object_id.clone()));
                }
                tracing::info!(%peer, %object_id, valid, delete_pending, "transfer receipt");
                MeshResponse::ReceiptAccepted { delete_pending }
            }
            MeshRequest::DeliverEnvelope { envelope } => {
                let authorized = self.allow_all_peers || self.allowed_peers.contains(&peer);
                if !authorized {
                    MeshResponse::Error {
                        message: format!("peer {peer} is not allowed"),
                    }
                } else if envelope.network_id != self.advertisement.network_id
                    || envelope.from_peer != peer.to_string()
                    || envelope.to_peer != self.advertisement.peer_id
                    || !envelope.is_fresh()
                {
                    MeshResponse::Error {
                        message: "invalid or expired envelope".into(),
                    }
                } else {
                    match self.mailbox.put(&envelope) {
                        Ok(()) => MeshResponse::EnvelopeAccepted { id: envelope.id },
                        Err(error) => MeshResponse::Error {
                            message: error.to_string(),
                        },
                    }
                }
            }
        };
        let _ = self
            .swarm
            .behaviour_mut()
            .request_response
            .send_response(channel, response);
    }
}

pub async fn serve(options: NodeOptions, allow_source_delete: bool) -> Result<()> {
    let mut node = MeshNode::new(options).await?;
    let inventory = node.store.inventory()?;
    for object in &inventory {
        let provider_key = node.provider_key(&object.object_id);
        if let Err(error) = node
            .swarm
            .behaviour_mut()
            .kademlia
            .start_providing(provider_key)
        {
            tracing::debug!(%error, "provider announcement waiting for peers");
        }
    }
    let mut advertise = interval(Duration::from_secs(30));
    advertise.set_missed_tick_behavior(MissedTickBehavior::Delay);
    node.publish_advertisement();
    println!(
        "{}",
        serde_json::json!({
            "event": "started",
            "peer_id": node.advertisement.peer_id,
            "objects": inventory,
        })
    );

    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => return Ok(()),
            _ = advertise.tick() => node.publish_advertisement(),
            event = node.swarm.select_next_some() => match event {
                SwarmEvent::NewListenAddr { address, .. } => {
                    let full = address.with(Protocol::P2p(*node.swarm.local_peer_id()));
                    let text = full.to_string();
                    if !node.advertisement.listen_addresses.contains(&text) {
                        node.advertisement.listen_addresses.push(text.clone());
                    }
                    node.publish_advertisement();
                    println!("{}", serde_json::json!({"event":"listening","address":text}));
                }
                SwarmEvent::ConnectionEstablished { peer_id, .. } => {
                    node.swarm.behaviour_mut().gossipsub.add_explicit_peer(&peer_id);
                    node.publish_advertisement();
                    for object in &inventory {
                        let provider_key = node.provider_key(&object.object_id);
                        let _ = node
                            .swarm
                            .behaviour_mut()
                            .kademlia
                            .start_providing(provider_key);
                    }
                }
                SwarmEvent::Behaviour(BehaviourEvent::Mdns(mdns::Event::Discovered(peers))) => {
                    for (peer, address) in peers {
                        node.add_peer_address(peer, address.clone());
                        node.swarm.behaviour_mut().gossipsub.add_explicit_peer(&peer);
                        let _ = node.swarm.dial(address.with(Protocol::P2p(peer)));
                    }
                }
                SwarmEvent::Behaviour(BehaviourEvent::Mdns(mdns::Event::Expired(peers))) => {
                    for (peer, _) in peers {
                        node.swarm.behaviour_mut().gossipsub.remove_explicit_peer(&peer);
                    }
                }
                SwarmEvent::Behaviour(BehaviourEvent::Identify(identify::Event::Received { peer_id, info, .. })) => {
                    for address in info.listen_addrs {
                        node.add_peer_address(peer_id, address);
                    }
                }
                SwarmEvent::Behaviour(BehaviourEvent::RequestResponse(request_response::Event::Message {
                    peer,
                    message: request_response::Message::Request { request, channel, .. },
                    ..
                })) => node.handle_inbound_request(peer, request, channel, allow_source_delete),
                SwarmEvent::Behaviour(BehaviourEvent::Gossipsub(gossipsub::Event::Message { message, .. })) => {
                    if let (Some(source), Ok(advertisement)) = (
                        message.source,
                        serde_json::from_slice::<AgentAdvertisement>(&message.data),
                    ) && advertisement.network_id == node.advertisement.network_id
                        && advertisement.peer_id == source.to_string()
                        && advertisement.is_fresh(Utc::now()) {
                        println!("{}", serde_json::json!({"event":"member","advertisement":advertisement}));
                    }
                }
                _ => {}
            }
        }
    }
}

pub async fn discover(options: NodeOptions, seconds: u64) -> Result<Vec<PeerSnapshot>> {
    let mut node = MeshNode::new(options).await?;
    let mut pending = HashMap::new();
    let mut advertisements: HashMap<PeerId, AgentAdvertisement> = HashMap::new();
    let mut inventories: HashMap<PeerId, Vec<ObjectSummary>> = HashMap::new();
    let mut route: HashMap<PeerId, RouteKind> = HashMap::new();
    let mut rtt: HashMap<PeerId, f64> = HashMap::new();
    let deadline = Instant::now() + Duration::from_secs(seconds.max(1));

    for peer in node.bootstrap_peers.clone() {
        route.insert(peer, RouteKind::DirectPublic);
    }

    while Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let Ok(Some(event)) = timeout(remaining, node.swarm.next()).await else {
            break;
        };
        match event {
            SwarmEvent::NewListenAddr { address, .. } => {
                let full = address.with(Protocol::P2p(*node.swarm.local_peer_id()));
                node.advertisement.listen_addresses.push(full.to_string());
            }
            SwarmEvent::ConnectionEstablished {
                peer_id, endpoint, ..
            } => {
                node.swarm
                    .behaviour_mut()
                    .gossipsub
                    .add_explicit_peer(&peer_id);
                route.insert(peer_id, classify_route(&endpoint));
                node.request_peer_snapshot(peer_id, &mut pending);
            }
            SwarmEvent::Behaviour(BehaviourEvent::Mdns(mdns::Event::Discovered(peers))) => {
                for (peer, address) in peers {
                    node.add_peer_address(peer, address.clone());
                    route.insert(peer, RouteKind::DirectPrivate);
                    let _ = node.swarm.dial(address.with(Protocol::P2p(peer)));
                }
            }
            SwarmEvent::Behaviour(BehaviourEvent::Identify(identify::Event::Received {
                peer_id,
                info,
                ..
            })) => {
                for address in info.listen_addrs {
                    node.add_peer_address(peer_id, address);
                }
            }
            SwarmEvent::Behaviour(BehaviourEvent::Gossipsub(gossipsub::Event::Message {
                message,
                ..
            })) => {
                if let (Some(source), Ok(advertisement)) = (
                    message.source,
                    serde_json::from_slice::<AgentAdvertisement>(&message.data),
                ) && advertisement.network_id == node.advertisement.network_id
                    && advertisement.peer_id == source.to_string()
                    && advertisement.is_fresh(Utc::now())
                {
                    advertisements.insert(source, advertisement);
                }
            }
            SwarmEvent::Behaviour(BehaviourEvent::Ping(ping::Event {
                peer,
                result: Ok(duration),
                ..
            })) => {
                rtt.insert(peer, duration.as_secs_f64() * 1000.0);
            }
            SwarmEvent::Behaviour(BehaviourEvent::RequestResponse(
                request_response::Event::Message { peer, message, .. },
            )) => match message {
                request_response::Message::Response {
                    request_id,
                    response,
                } => match pending.remove(&request_id).map(|entry| entry.1) {
                    Some(PendingKind::Advertisement) => {
                        if let MeshResponse::Advertisement(advertisement) = response
                            && advertisement.network_id == node.advertisement.network_id
                            && advertisement.peer_id == peer.to_string()
                            && advertisement.is_fresh(Utc::now())
                        {
                            advertisements.insert(peer, *advertisement);
                        }
                    }
                    Some(PendingKind::Inventory) => {
                        if let MeshResponse::Inventory(inventory) = response {
                            inventories.insert(peer, inventory);
                        }
                    }
                    None => {}
                },
                request_response::Message::Request {
                    request, channel, ..
                } => {
                    node.handle_inbound_request(peer, request, channel, false);
                }
            },
            _ => {}
        }
    }

    let snapshots = advertisements
        .into_iter()
        .map(|(peer_id, advertisement)| PeerSnapshot {
            peer_id,
            inventory: inventories.remove(&peer_id).unwrap_or_default(),
            route: route
                .get(&peer_id)
                .copied()
                .unwrap_or(RouteKind::DirectPublic),
            observed_rtt_ms: rtt.get(&peer_id).copied().unwrap_or(250.0),
            advertisement,
        })
        .collect();
    Ok(snapshots)
}

async fn get_with_node(
    node: &mut MeshNode,
    object_id: &str,
    output: &Path,
    max_cost: f64,
    optimize: OptimizeFor,
    discovery_seconds: u64,
    request_source_delete: bool,
) -> Result<TransferPlan> {
    let local_capabilities = node.advertisement.capabilities.clone();
    let local_store = node.store.clone();
    let snapshots = discover_with_node(node, discovery_seconds, Some(object_id)).await?;
    let mut candidates: Vec<Candidate> = snapshots
        .into_iter()
        .filter_map(|snapshot| {
            snapshot
                .inventory
                .iter()
                .find(|object| object.object_id == object_id)
                .cloned()
                .map(|object| Candidate {
                    peer_id: snapshot.peer_id,
                    advertisement: snapshot.advertisement,
                    object,
                    route: snapshot.route,
                    observed_rtt_ms: snapshot.observed_rtt_ms,
                })
        })
        .collect();
    let mut plan = choose_best(
        &local_capabilities,
        &candidates,
        max_cost,
        optimize,
        Utc::now(),
    )
    .ok_or_else(|| anyhow!("no fresh provider satisfies reachability and budget constraints"))?;
    let remote_object = candidates
        .iter()
        .find(|candidate| candidate.peer_id == plan.peer_id)
        .map(|candidate| candidate.object.clone())
        .ok_or_else(|| anyhow!("selected provider inventory disappeared"))?;

    // Repeatedly select the best remaining peer to build a deterministic fallback list.
    let mut plans = vec![plan.clone()];
    candidates.retain(|candidate| candidate.peer_id != plan.peer_id);
    while let Some(next) = choose_best(
        &local_capabilities,
        &candidates,
        max_cost,
        optimize,
        Utc::now(),
    ) {
        candidates.retain(|candidate| candidate.peer_id != next.peer_id);
        plans.push(next);
    }

    let object = local_store
        .inventory()?
        .into_iter()
        .find(|entry| entry.object_id == object_id);
    if object.is_none() {
        let mut writer = local_store.create_download(object_id)?;
        for index in 0..remote_object.chunk_count {
            let mut last_error = None;
            let mut received = None;
            for candidate in &plans {
                match request_chunk(node, candidate.peer_id, object_id, index).await {
                    Ok(data) => {
                        received = Some(data);
                        break;
                    }
                    Err(error) => last_error = Some(error),
                }
            }
            let data = received.ok_or_else(|| {
                last_error.unwrap_or_else(|| anyhow!("all providers failed for chunk {index}"))
            })?;
            writer.append(&data)?;
        }
        let stored = writer.finish()?;
        if stored != output {
            local_store.export(object_id, output)?;
        }
    } else {
        local_store.export(object_id, output)?;
    }

    let actual = sha256_file(output)?;
    if actual != object_id {
        bail!("final output checksum mismatch")
    }
    let receipt = MeshRequest::TransferReceipt {
        object_id: object_id.to_owned(),
        received_sha256: actual,
        request_source_delete,
    };
    if let Ok(MeshResponse::ReceiptAccepted { delete_pending }) =
        request_once(node, plan.peer_id, receipt).await
    {
        plan.source_delete_pending = Some(delete_pending);
    }
    Ok(plan)
}

async fn discover_with_node(
    node: &mut MeshNode,
    seconds: u64,
    target_object: Option<&str>,
) -> Result<Vec<PeerSnapshot>> {
    let mut pending = HashMap::new();
    let mut advertisements: HashMap<PeerId, AgentAdvertisement> = HashMap::new();
    let mut inventories: HashMap<PeerId, Vec<ObjectSummary>> = HashMap::new();
    let mut route: HashMap<PeerId, RouteKind> = node
        .bootstrap_peers
        .iter()
        .copied()
        .map(|peer| (peer, RouteKind::DirectPublic))
        .collect();
    let mut rtt: HashMap<PeerId, f64> = HashMap::new();
    if let Some(object_id) = target_object {
        let provider_key = node.provider_key(object_id);
        node.swarm
            .behaviour_mut()
            .kademlia
            .get_providers(provider_key);
    }
    node.publish_advertisement();
    let deadline = Instant::now() + Duration::from_secs(seconds.max(1));
    while Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let Ok(Some(event)) = timeout(remaining, node.swarm.next()).await else {
            break;
        };
        match event {
            SwarmEvent::ConnectionEstablished {
                peer_id, endpoint, ..
            } => {
                node.swarm
                    .behaviour_mut()
                    .gossipsub
                    .add_explicit_peer(&peer_id);
                route.insert(peer_id, classify_route(&endpoint));
                node.request_peer_snapshot(peer_id, &mut pending);
                node.publish_advertisement();
            }
            SwarmEvent::Behaviour(BehaviourEvent::Mdns(mdns::Event::Discovered(peers))) => {
                for (peer, address) in peers {
                    node.add_peer_address(peer, address.clone());
                    route.insert(peer, RouteKind::DirectPrivate);
                    let _ = node.swarm.dial(address.with(Protocol::P2p(peer)));
                }
            }
            SwarmEvent::Behaviour(BehaviourEvent::RequestResponse(
                request_response::Event::Message { peer, message, .. },
            )) => match message {
                request_response::Message::Response {
                    request_id,
                    response,
                } => match pending.remove(&request_id).map(|entry| entry.1) {
                    Some(PendingKind::Advertisement) => {
                        if let MeshResponse::Advertisement(advertisement) = response
                            && advertisement.network_id == node.advertisement.network_id
                            && advertisement.peer_id == peer.to_string()
                            && advertisement.is_fresh(Utc::now())
                        {
                            advertisements.insert(peer, *advertisement);
                        }
                    }
                    Some(PendingKind::Inventory) => {
                        if let MeshResponse::Inventory(inventory) = response {
                            inventories.insert(peer, inventory);
                        }
                    }
                    None => {}
                },
                request_response::Message::Request {
                    request, channel, ..
                } => {
                    node.handle_inbound_request(peer, request, channel, false);
                }
            },
            SwarmEvent::Behaviour(BehaviourEvent::Identify(identify::Event::Received {
                peer_id,
                info,
                ..
            })) => {
                for address in info.listen_addrs {
                    node.add_peer_address(peer_id, address);
                }
            }
            SwarmEvent::Behaviour(BehaviourEvent::Kademlia(
                kad::Event::OutboundQueryProgressed {
                    result:
                        kad::QueryResult::GetProviders(Ok(kad::GetProvidersOk::FoundProviders {
                            providers,
                            ..
                        })),
                    ..
                },
            )) => {
                for peer in providers {
                    if peer != *node.swarm.local_peer_id() {
                        route.entry(peer).or_insert(RouteKind::DirectPublic);
                        node.request_peer_snapshot(peer, &mut pending);
                    }
                }
            }
            SwarmEvent::Behaviour(BehaviourEvent::Gossipsub(gossipsub::Event::Message {
                message,
                ..
            })) => {
                if let (Some(source), Ok(advertisement)) = (
                    message.source,
                    serde_json::from_slice::<AgentAdvertisement>(&message.data),
                ) && advertisement.network_id == node.advertisement.network_id
                    && advertisement.peer_id == source.to_string()
                    && advertisement.is_fresh(Utc::now())
                {
                    advertisements.insert(source, advertisement);
                }
            }
            SwarmEvent::Behaviour(BehaviourEvent::Ping(ping::Event {
                peer,
                result: Ok(duration),
                ..
            })) => {
                rtt.insert(peer, duration.as_secs_f64() * 1000.0);
            }
            SwarmEvent::NewListenAddr { address, .. } => {
                let full = address.with(Protocol::P2p(*node.swarm.local_peer_id()));
                node.advertisement.listen_addresses.push(full.to_string());
            }
            _ => {}
        }
    }
    Ok(advertisements
        .into_iter()
        .map(|(peer_id, advertisement)| PeerSnapshot {
            peer_id,
            inventory: inventories.remove(&peer_id).unwrap_or_default(),
            route: route
                .get(&peer_id)
                .copied()
                .unwrap_or(RouteKind::DirectPublic),
            observed_rtt_ms: rtt.get(&peer_id).copied().unwrap_or(250.0),
            advertisement,
        })
        .collect())
}

async fn request_chunk(
    node: &mut MeshNode,
    peer: PeerId,
    object_id: &str,
    index: u64,
) -> Result<Vec<u8>> {
    let response = request_once(
        node,
        peer,
        MeshRequest::GetChunk {
            object_id: object_id.to_owned(),
            index,
        },
    )
    .await?;
    match response {
        MeshResponse::Chunk {
            object_id: response_object,
            index: response_index,
            data_sha256,
            data,
            ..
        } if response_object == object_id && response_index == index => {
            let actual = hex::encode(Sha256::digest(&data));
            if actual != data_sha256 {
                bail!("chunk checksum mismatch from {peer}")
            }
            Ok(data)
        }
        MeshResponse::Error { message } => bail!("peer {peer}: {message}"),
        _ => bail!("peer {peer} returned an invalid chunk response"),
    }
}

async fn request_once(
    node: &mut MeshNode,
    peer: PeerId,
    request: MeshRequest,
) -> Result<MeshResponse> {
    let request_id = node
        .swarm
        .behaviour_mut()
        .request_response
        .send_request(&peer, request);
    timeout(Duration::from_secs(30), async {
        loop {
            match node.swarm.select_next_some().await {
                SwarmEvent::Behaviour(BehaviourEvent::RequestResponse(
                    request_response::Event::Message {
                        peer: source,
                        message,
                        ..
                    },
                )) => match message {
                    request_response::Message::Response {
                        request_id: id,
                        response,
                    } if id == request_id && source == peer => return Ok(response),
                    request_response::Message::Request {
                        request, channel, ..
                    } => {
                        node.handle_inbound_request(source, request, channel, false);
                    }
                    _ => {}
                },
                SwarmEvent::Behaviour(BehaviourEvent::RequestResponse(
                    request_response::Event::OutboundFailure {
                        request_id: id,
                        error,
                        ..
                    },
                )) if id == request_id => return Err(anyhow!(error)),
                _ => {}
            }
        }
    })
    .await
    .map_err(|_| anyhow!("request to {peer} timed out"))?
}

fn peer_from_multiaddr(address: &Multiaddr) -> Result<PeerId> {
    match address.iter().last() {
        Some(Protocol::P2p(peer)) => Ok(peer),
        _ => bail!("bootstrap address must end in /p2p/<peer-id>"),
    }
}

fn strip_peer(mut address: Multiaddr) -> Multiaddr {
    if matches!(address.iter().last(), Some(Protocol::P2p(_))) {
        address.pop();
    }
    address
}

fn classify_route(endpoint: &libp2p::core::ConnectedPoint) -> RouteKind {
    if endpoint.is_relayed() {
        return RouteKind::Relayed;
    }
    let private = endpoint
        .get_remote_address()
        .iter()
        .any(|protocol| match protocol {
            Protocol::Ip4(address) => {
                address.is_private() || address.is_loopback() || address.is_link_local()
            }
            Protocol::Ip6(address) => {
                address.is_loopback()
                    || address.is_unique_local()
                    || address.is_unicast_link_local()
            }
            Protocol::Memory(_) => true,
            _ => false,
        });
    if private {
        RouteKind::DirectPrivate
    } else {
        RouteKind::DirectPublic
    }
}

fn sha256_file(path: &Path) -> Result<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(hex::encode(digest.finalize()))
}

pub struct DaemonOptions {
    pub node: NodeOptions,
    pub state_dir: PathBuf,
    pub control_listen: SocketAddr,
    pub allow_source_delete: bool,
}

struct ControlCommand {
    request: RpcRequest,
    reply: oneshot::Sender<RpcResponse>,
}

struct PendingEnvelope {
    envelope_id: Uuid,
    deadline: Instant,
    reply: oneshot::Sender<RpcResponse>,
}

#[derive(Debug, Deserialize)]
struct SendParams {
    peer_id: String,
    kind: EnvelopeKind,
    payload: Value,
    #[serde(default)]
    correlation_id: Option<Uuid>,
    #[serde(default = "default_envelope_ttl")]
    ttl_seconds: u64,
}

#[derive(Debug, Deserialize)]
struct InboxParams {
    #[serde(default)]
    kind: Option<EnvelopeKind>,
    #[serde(default = "default_inbox_limit")]
    limit: usize,
}

#[derive(Debug, Deserialize)]
struct FetchParams {
    object_id: String,
    output: PathBuf,
    #[serde(default = "default_max_cost")]
    max_cost: f64,
    #[serde(default = "default_optimize")]
    optimize: String,
    #[serde(default = "default_discovery_seconds")]
    discovery_seconds: u64,
    #[serde(default)]
    request_source_delete: bool,
}

fn default_envelope_ttl() -> u64 {
    3600
}

fn default_inbox_limit() -> usize {
    100
}

fn default_max_cost() -> f64 {
    1_000_000_000.0
}

fn default_optimize() -> String {
    "balanced".into()
}

fn default_discovery_seconds() -> u64 {
    5
}

/// Run the long-lived node. The daemon exclusively owns the identity and Swarm;
/// both the CLI and Harness plugin use the authenticated loopback control plane.
pub async fn daemon(options: DaemonOptions) -> Result<()> {
    let DaemonOptions {
        node: node_options,
        state_dir,
        control_listen,
        allow_source_delete,
    } = options;
    std::fs::create_dir_all(&state_dir)?;
    let token = Uuid::new_v4().simple().to_string();
    let mut node = MeshNode::new(node_options).await?;
    let listener = TcpListener::bind(control_listen).await?;
    let address = listener.local_addr()?;
    let control = ControlFile {
        version: 1,
        address,
        token: token.clone(),
        peer_id: node.advertisement.peer_id.clone(),
    };
    write_control_file(&state_dir.join("control.json"), &control)?;

    let inventory = node.store.inventory()?;
    for object in &inventory {
        let key = node.provider_key(&object.object_id);
        let _ = node.swarm.behaviour_mut().kademlia.start_providing(key);
    }
    let (control_tx, mut control_rx) = mpsc::channel::<ControlCommand>(128);
    tokio::spawn(control_server(listener, control_tx));

    let mut advertisements: HashMap<PeerId, AgentAdvertisement> = HashMap::new();
    let mut inventories: HashMap<PeerId, Vec<ObjectSummary>> = HashMap::new();
    let mut routes: HashMap<PeerId, RouteKind> = node
        .bootstrap_peers
        .iter()
        .copied()
        .map(|peer| (peer, RouteKind::DirectPublic))
        .collect();
    let mut rtts: HashMap<PeerId, f64> = HashMap::new();
    let mut pending_snapshot = HashMap::new();
    let mut pending_envelopes: HashMap<OutboundRequestId, PendingEnvelope> = HashMap::new();
    let mut advertise = interval(Duration::from_secs(30));
    advertise.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut housekeeping = interval(Duration::from_secs(1));
    housekeeping.set_missed_tick_behavior(MissedTickBehavior::Delay);
    node.publish_advertisement();
    println!(
        "{}",
        json!({
            "event":"daemon_started",
            "peer_id":node.advertisement.peer_id,
            "control":address,
            "objects":inventory,
        })
    );

    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                let _ = std::fs::remove_file(state_dir.join("control.json"));
                return Ok(())
            },
            _ = advertise.tick() => node.publish_advertisement(),
            _ = housekeeping.tick() => {
                let now = Instant::now();
                let expired: Vec<_> = pending_envelopes.iter()
                    .filter_map(|(id, pending)| (pending.deadline <= now).then_some(*id))
                    .collect();
                for id in expired {
                    if let Some(pending) = pending_envelopes.remove(&id) {
                        let _ = pending.reply.send(RpcResponse::failure("P2P envelope acknowledgement timed out"));
                    }
                }
                advertisements.retain(|_, ad| ad.is_fresh(Utc::now()));
            },
            Some(command) = control_rx.recv() => {
                if command.request.token != token {
                    let _ = command.reply.send(RpcResponse::failure("unauthorized"));
                    continue;
                }
                match command.request.method.as_str() {
                    "status" => {
                        let result = json!({
                            "version":1,
                            "peer_id":node.advertisement.peer_id,
                            "network_id":node.advertisement.network_id,
                            "name":node.advertisement.agent_name,
                            "listen_addresses":node.advertisement.listen_addresses,
                            "connected_peers":node.swarm.connected_peers().count(),
                            "objects":node.store.inventory().unwrap_or_default().len(),
                        });
                        let _ = command.reply.send(RpcResponse::success(result));
                    }
                    "peers" => {
                        let peers: Vec<Value> = advertisements.iter().map(|(peer, ad)| json!({
                            "peer_id":peer.to_string(),
                            "advertisement":ad,
                            "inventory":inventories.get(peer).cloned().unwrap_or_default(),
                            "route":format!("{:?}", routes.get(peer).copied().unwrap_or(RouteKind::DirectPublic)),
                            "observed_rtt_ms":rtts.get(peer).copied().unwrap_or(250.0),
                        })).collect();
                        let _ = command.reply.send(RpcResponse::success(json!(peers)));
                    }
                    "publish" => {
                        let path = command.request.params.get("path").and_then(Value::as_str);
                        let response = match path {
                            Some(path) => node.store.import(Path::new(path)).map(|object| {
                                let provider_key = node.provider_key(&object.object_id);
                                // Import is durable even while isolated. Every later connection
                                // republishes the full inventory, so lack of a current DHT peer is
                                // not an error for the local publish operation.
                                let _ = node.swarm.behaviour_mut().kademlia.start_providing(provider_key);
                                RpcResponse::success(json!(object))
                            }).unwrap_or_else(RpcResponse::failure),
                            None => RpcResponse::failure("publish requires params.path"),
                        };
                        let _ = command.reply.send(response);
                    }
                    "fetch" => {
                        let params = match serde_json::from_value::<FetchParams>(command.request.params) {
                            Ok(params) => params,
                            Err(error) => {
                                let _ = command.reply.send(RpcResponse::failure(error));
                                continue;
                            }
                        };
                        let optimize = match params.optimize.parse::<OptimizeFor>() {
                            Ok(optimize) => optimize,
                            Err(error) => {
                                let _ = command.reply.send(RpcResponse::failure(error));
                                continue;
                            }
                        };
                        let response = get_with_node(
                            &mut node,
                            &params.object_id,
                            &params.output,
                            params.max_cost,
                            optimize,
                            params.discovery_seconds,
                            params.request_source_delete,
                        ).await.map(|plan| RpcResponse::success(json!({
                            "object_id":params.object_id,
                            "output":params.output,
                            "provider":plan.peer_id.to_string(),
                            "route":format!("{:?}",plan.route),
                            "estimated_cost":plan.estimated_cost,
                            "estimated_seconds":plan.estimated_seconds,
                            "reason":plan.reason,
                            "source_delete_pending":plan.source_delete_pending,
                        }))).unwrap_or_else(RpcResponse::failure);
                        let _ = command.reply.send(response);
                    }
                    "inbox.list" => {
                        let response = serde_json::from_value::<InboxParams>(command.request.params)
                            .map_err(anyhow::Error::from)
                            .and_then(|params| node.mailbox.list(params.kind, params.limit))
                            .map(|items| RpcResponse::success(json!(items)))
                            .unwrap_or_else(RpcResponse::failure);
                        let _ = command.reply.send(response);
                    }
                    "inbox.ack" => {
                        let response = command.request.params.get("id").and_then(Value::as_str)
                            .ok_or_else(|| anyhow!("inbox.ack requires params.id"))
                            .and_then(|id| Uuid::parse_str(id).map_err(anyhow::Error::from))
                            .and_then(|id| node.mailbox.ack(id))
                            .map(|()| RpcResponse::success(json!({"acked":true})))
                            .unwrap_or_else(RpcResponse::failure);
                        let _ = command.reply.send(response);
                    }
                    "send" => {
                        let params = match serde_json::from_value::<SendParams>(command.request.params) {
                            Ok(params) => params,
                            Err(error) => {
                                let _ = command.reply.send(RpcResponse::failure(error));
                                continue;
                            }
                        };
                        let peer: PeerId = match params.peer_id.parse() {
                            Ok(peer) => peer,
                            Err(error) => {
                                let _ = command.reply.send(RpcResponse::failure(error));
                                continue;
                            }
                        };
                        if !(node.allow_all_peers || node.allowed_peers.contains(&peer)) {
                            let _ = command.reply.send(RpcResponse::failure(format!("peer {peer} is not allowed")));
                            continue;
                        }
                        let envelope = Envelope::new(
                            node.advertisement.network_id.clone(),
                            node.advertisement.peer_id.clone(),
                            peer.to_string(),
                            params.kind,
                            params.correlation_id,
                            params.ttl_seconds,
                            params.payload,
                        );
                        let envelope_id = envelope.id;
                        let request_id = node.swarm.behaviour_mut().request_response
                            .send_request(&peer, MeshRequest::DeliverEnvelope { envelope });
                        pending_envelopes.insert(request_id, PendingEnvelope {
                            envelope_id,
                            deadline: Instant::now() + Duration::from_secs(30),
                            reply: command.reply,
                        });
                    }
                    method => {
                        let _ = command.reply.send(RpcResponse::failure(format!("unknown method {method}")));
                    }
                }
            },
            event = node.swarm.select_next_some() => match event {
                SwarmEvent::NewListenAddr { address, .. } => {
                    let full = address.with(Protocol::P2p(*node.swarm.local_peer_id()));
                    let text = full.to_string();
                    if !node.advertisement.listen_addresses.contains(&text) {
                        node.advertisement.listen_addresses.push(text);
                        node.publish_advertisement();
                    }
                }
                SwarmEvent::ConnectionEstablished { peer_id, endpoint, .. } => {
                    node.swarm.behaviour_mut().gossipsub.add_explicit_peer(&peer_id);
                    routes.insert(peer_id, classify_route(&endpoint));
                    node.request_peer_snapshot(peer_id, &mut pending_snapshot);
                    node.publish_advertisement();
                    for object in node.store.inventory().unwrap_or_default() {
                        let key = node.provider_key(&object.object_id);
                        let _ = node.swarm.behaviour_mut().kademlia.start_providing(key);
                    }
                }
                SwarmEvent::Behaviour(BehaviourEvent::Mdns(mdns::Event::Discovered(peers))) => {
                    for (peer, address) in peers {
                        node.add_peer_address(peer, address.clone());
                        routes.insert(peer, RouteKind::DirectPrivate);
                        node.swarm.behaviour_mut().gossipsub.add_explicit_peer(&peer);
                        let _ = node.swarm.dial(address.with(Protocol::P2p(peer)));
                    }
                }
                SwarmEvent::Behaviour(BehaviourEvent::Mdns(mdns::Event::Expired(peers))) => {
                    for (peer, _) in peers {
                        node.swarm.behaviour_mut().gossipsub.remove_explicit_peer(&peer);
                    }
                }
                SwarmEvent::Behaviour(BehaviourEvent::Identify(identify::Event::Received { peer_id, info, .. })) => {
                    for address in info.listen_addrs { node.add_peer_address(peer_id, address); }
                }
                SwarmEvent::Behaviour(BehaviourEvent::Ping(ping::Event { peer, result: Ok(duration), .. })) => {
                    rtts.insert(peer, duration.as_secs_f64() * 1000.0);
                }
                SwarmEvent::Behaviour(BehaviourEvent::Gossipsub(gossipsub::Event::Message { message, .. })) => {
                    if let (Some(source), Ok(advertisement)) = (
                        message.source,
                        serde_json::from_slice::<AgentAdvertisement>(&message.data),
                    ) && advertisement.network_id == node.advertisement.network_id
                        && advertisement.peer_id == source.to_string()
                        && advertisement.is_fresh(Utc::now()) {
                        advertisements.insert(source, advertisement);
                    }
                }
                SwarmEvent::Behaviour(BehaviourEvent::RequestResponse(request_response::Event::Message { peer, message, .. })) => match message {
                    request_response::Message::Request { request, channel, .. } => {
                        node.handle_inbound_request(peer, request, channel, allow_source_delete);
                    }
                    request_response::Message::Response { request_id, response } => {
                        if let Some(pending) = pending_envelopes.remove(&request_id) {
                            let reply = match response {
                                MeshResponse::EnvelopeAccepted { id } if id == pending.envelope_id =>
                                    RpcResponse::success(json!({"id":id,"accepted":true})),
                                MeshResponse::Error { message } => RpcResponse::failure(message),
                                _ => RpcResponse::failure("peer returned an invalid envelope acknowledgement"),
                            };
                            let _ = pending.reply.send(reply);
                        } else if let Some((expected_peer, kind)) = pending_snapshot.remove(&request_id)
                            && expected_peer == peer {
                            match (kind, response) {
                                (PendingKind::Advertisement, MeshResponse::Advertisement(ad))
                                    if ad.network_id == node.advertisement.network_id
                                        && ad.peer_id == peer.to_string()
                                        && ad.is_fresh(Utc::now()) => { advertisements.insert(peer, *ad); }
                                (PendingKind::Inventory, MeshResponse::Inventory(items)) => { inventories.insert(peer, items); }
                                _ => {}
                            }
                        }
                    }
                },
                SwarmEvent::Behaviour(BehaviourEvent::RequestResponse(request_response::Event::OutboundFailure { request_id, error, .. })) => {
                    if let Some(pending) = pending_envelopes.remove(&request_id) {
                        let _ = pending.reply.send(RpcResponse::failure(error));
                    }
                }
                _ => {}
            }
        }
    }
}

async fn control_server(listener: TcpListener, sender: mpsc::Sender<ControlCommand>) {
    loop {
        let Ok((stream, _)) = listener.accept().await else {
            return;
        };
        let sender = sender.clone();
        tokio::spawn(async move {
            if let Err(error) = serve_control_connection(stream, sender).await {
                tracing::debug!(%error, "control request failed");
            }
        });
    }
}

async fn serve_control_connection(
    stream: TcpStream,
    sender: mpsc::Sender<ControlCommand>,
) -> Result<()> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).await?;
    if line.len() > 1024 * 1024 {
        bail!("control request exceeds 1 MiB")
    }
    let request: RpcRequest = serde_json::from_str(&line)?;
    let (reply_tx, reply_rx) = oneshot::channel();
    sender
        .send(ControlCommand {
            request,
            reply: reply_tx,
        })
        .await?;
    let response = reply_rx
        .await
        .unwrap_or_else(|_| RpcResponse::failure("daemon stopped"));
    let mut bytes = serde_json::to_vec(&response)?;
    bytes.push(b'\n');
    reader.get_mut().write_all(&bytes).await?;
    Ok(())
}

fn write_control_file(path: &Path, control: &ControlFile) -> Result<()> {
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, serde_json::to_vec_pretty(control)?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(temporary, path)?;
    Ok(())
}
