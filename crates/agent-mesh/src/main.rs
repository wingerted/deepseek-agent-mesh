use std::{
    collections::{BTreeSet, HashSet},
    net::SocketAddr,
    path::PathBuf,
};

use agent_mesh::{
    envelope::EnvelopeKind,
    identity, ipc,
    mailbox::Mailbox,
    membership::{JoinHint, JoinTicket, MembershipManager},
    model::{AgentCapabilities, LeaderCapabilities, NodeRole},
    network::{self, NodeOptions},
    planner::OptimizeFor,
    store::ObjectStore,
};
use anyhow::Result;
use clap::{Parser, Subcommand, ValueEnum};
use libp2p::Multiaddr;
use libp2p::PeerId;
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
#[command(
    name = "agent-mesh",
    version,
    about = "Cost-aware P2P resource discovery and content transfer agent"
)]
struct Cli {
    /// Identity key path. Defaults to <state-dir>/identity.key.
    #[arg(long, global = true)]
    identity: Option<PathBuf>,

    /// Object store path. Defaults to <state-dir>/store.
    #[arg(long, global = true)]
    store: Option<PathBuf>,

    /// Runtime state shared by the daemon, CLI, and Harness plugin.
    #[arg(long, default_value = ".agent-mesh", global = true)]
    state_dir: PathBuf,

    #[arg(long, default_value = "agent", global = true)]
    name: String,

    /// Discovery namespace. This is not an authentication boundary.
    #[arg(long, global = true)]
    network_id: Option<String>,

    #[arg(long, global = true)]
    listen: Vec<Multiaddr>,

    /// A full address ending in /p2p/<peer-id>. May be repeated.
    #[arg(long, global = true)]
    bootstrap: Vec<Multiaddr>,

    /// Peer IDs allowed to exchange agent messages and tasks. May be repeated.
    #[arg(long, global = true)]
    allow_peer: Vec<PeerId>,

    /// Explicit development-mode opt-in; never implied by an empty allowlist.
    #[arg(long, global = true)]
    allow_all_peers: bool,

    #[arg(long, default_value = "local", global = true)]
    region: String,

    #[arg(long, default_value = "default", global = true)]
    zone: String,

    #[arg(long, default_value = "CNY", global = true)]
    currency: String,

    /// Equal non-secret tags declare that two members share a private path.
    #[arg(long, global = true)]
    private_network: Vec<String>,

    #[arg(long, default_value_t = 1_000_000_000_000_u64, global = true)]
    storage_free_bytes: u64,

    /// Operator-declared capacity hint; no speed test is run automatically.
    #[arg(long, default_value_t = 100.0, global = true)]
    ingress_mbps: f64,

    /// Operator-declared capacity hint; no speed test is run automatically.
    #[arg(long, default_value_t = 100.0, global = true)]
    egress_mbps: f64,

    #[arg(long, default_value_t = 0.0, global = true)]
    load: f64,

    /// Egress price per GiB in the operator's configured currency.
    #[arg(long, default_value_t = 0.0, global = true)]
    idle_price_per_gib: f64,

    #[arg(long, default_value_t = 0.0, global = true)]
    busy_price_per_gib: f64,

    #[arg(long, default_value_t = 0, global = true)]
    idle_start_hour: u8,

    #[arg(long, default_value_t = 8, global = true)]
    idle_end_hour: u8,

    #[arg(long, default_value_t = 480, global = true)]
    utc_offset_minutes: i16,

    #[arg(long, global = true)]
    relay: bool,

    /// Leader federation protocol offered by this node. May be repeated.
    #[arg(long, global = true)]
    leader_protocol: Vec<String>,

    /// Aggregate role offered by this node's Leader and local Team. May be repeated.
    #[arg(long, global = true)]
    leader_role: Vec<String>,

    /// Logical workspace accepted by this Leader. Never exposes a filesystem path.
    #[arg(long, global = true)]
    leader_workspace: Vec<String>,

    #[arg(long, global = true)]
    leader_team_enabled: bool,

    #[arg(long, default_value_t = 1, global = true)]
    leader_max_parallel_tasks: u16,

    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Print this agent's stable peer ID.
    Id,

    /// Create a short-lived, single-use code for joining this running network.
    Invite {
        #[arg(long, default_value_t = 900)]
        ttl_seconds: u64,
    },

    /// Redeem an invitation and persist this node's network membership.
    Join { code: String },

    /// Run the persistent P2P node and authenticated local control service.
    Daemon {
        #[arg(long, default_value = "127.0.0.1:0")]
        control_listen: SocketAddr,
        #[arg(long)]
        allow_source_delete: bool,
    },

    /// Show the persistent node's status.
    Status,

    /// List fresh members known by the persistent node.
    Peers,

    /// Import and advertise a file through the persistent node.
    Publish { path: PathBuf },

    /// Send a one-way message to another Harness node.
    Message {
        peer_id: String,
        text: String,
        #[arg(long, default_value_t = 3600)]
        ttl_seconds: u64,
    },

    /// Ask another Harness node to execute a prompt in a fresh Session.
    Task {
        peer_id: String,
        prompt: String,
        #[arg(long, default_value_t = 3600)]
        ttl_seconds: u64,
    },

    /// Return a task result to the originating node.
    Reply {
        peer_id: String,
        correlation_id: uuid::Uuid,
        text: String,
        #[arg(long, default_value_t = 3600)]
        ttl_seconds: u64,
    },

    /// Request cancellation of a previously accepted Leader task.
    Cancel {
        peer_id: String,
        correlation_id: uuid::Uuid,
        #[arg(long, default_value_t = 3600)]
        ttl_seconds: u64,
    },

    /// Read durable incoming envelopes; data remains until explicitly acknowledged.
    Inbox {
        #[arg(long, value_enum)]
        kind: Option<EnvelopeKindArg>,
        #[arg(long, default_value_t = 100)]
        limit: usize,
    },

    /// Mark one incoming envelope processed.
    Ack { id: uuid::Uuid },

    /// Import files and serve the local content-addressed store.
    Serve {
        #[arg(long = "provide")]
        provide: Vec<PathBuf>,

        /// Honour a verified receiver's request by moving the source into delete-pending.
        #[arg(long)]
        allow_source_delete: bool,
    },

    /// Discover connected members and print their declarations and inventories.
    Discover {
        #[arg(long, default_value_t = 5)]
        seconds: u64,
    },

    /// Retrieve a SHA-256-addressed object using the best eligible provider.
    Get {
        object_id: String,
        #[arg(long)]
        output: PathBuf,
        #[arg(long, default_value_t = 1_000_000_000.0)]
        max_cost: f64,
        #[arg(long, value_enum, default_value_t = OptimizeArg::Balanced)]
        optimize: OptimizeArg,
        #[arg(long, default_value_t = 5)]
        discovery_seconds: u64,
        #[arg(long)]
        request_source_delete: bool,
    },
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum OptimizeArg {
    Cost,
    Speed,
    Balanced,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum EnvelopeKindArg {
    Message,
    Task,
    TaskCancel,
    TaskProgress,
    TaskResult,
}

impl From<EnvelopeKindArg> for EnvelopeKind {
    fn from(value: EnvelopeKindArg) -> Self {
        match value {
            EnvelopeKindArg::Message => Self::Message,
            EnvelopeKindArg::Task => Self::Task,
            EnvelopeKindArg::TaskCancel => Self::TaskCancel,
            EnvelopeKindArg::TaskProgress => Self::TaskProgress,
            EnvelopeKindArg::TaskResult => Self::TaskResult,
        }
    }
}

impl From<OptimizeArg> for OptimizeFor {
    fn from(value: OptimizeArg) -> Self {
        match value {
            OptimizeArg::Cost => Self::Cost,
            OptimizeArg::Speed => Self::Speed,
            OptimizeArg::Balanced => Self::Balanced,
        }
    }
}

impl OptimizeArg {
    fn as_str(self) -> &'static str {
        match self {
            Self::Cost => "cost",
            Self::Speed => "speed",
            Self::Balanced => "balanced",
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("warn,libp2p_mdns=off")),
        )
        .with_writer(std::io::stderr)
        .init();

    let cli = Cli::parse();
    let identity_path = cli
        .identity
        .clone()
        .unwrap_or_else(|| cli.state_dir.join("identity.key"));
    let store_path = cli
        .store
        .clone()
        .unwrap_or_else(|| cli.state_dir.join("store"));
    let keypair = identity::load_or_create(&identity_path)?;
    if matches!(cli.command, Command::Id) {
        println!("{}", keypair.public().to_peer_id());
        return Ok(());
    }

    let join_ticket = match &cli.command {
        Command::Join { code } if code.trim().starts_with("mesh1h:") => {
            Some(network::resolve_join_hint(keypair.clone(), JoinHint::decode(code)?).await?)
        }
        Command::Join { code } => Some(JoinTicket::decode(code)?),
        _ => None,
    };
    let persisted_membership = MembershipManager::load(&cli.state_dir)?;
    let network_id = join_ticket
        .as_ref()
        .map(|ticket| ticket.network_id.clone())
        .or(cli.network_id)
        .or_else(|| {
            persisted_membership
                .as_ref()
                .map(|state| state.network_id.clone())
        })
        .unwrap_or_else(|| "default".into());
    let mut bootstrap = cli.bootstrap;
    if let Some(ticket) = &join_ticket {
        bootstrap = ticket.bootstrap_addrs()?;
    } else if bootstrap.is_empty()
        && let Some(state) = &persisted_membership
    {
        bootstrap = state
            .bootstrap
            .iter()
            .map(|address| address.parse())
            .collect::<Result<Vec<_>, _>>()?;
    }

    let store = ObjectStore::open(&store_path)?;
    let mailbox = Mailbox::open(cli.state_dir.join("mailbox"))?;
    let leader_protocols = cli.leader_protocol.into_iter().collect::<BTreeSet<_>>();
    let leader = (!leader_protocols.is_empty()).then(|| LeaderCapabilities {
        protocols: leader_protocols,
        roles: cli.leader_role.into_iter().collect(),
        workspace_aliases: cli.leader_workspace.into_iter().collect(),
        team_enabled: cli.leader_team_enabled,
        max_parallel_tasks: cli.leader_max_parallel_tasks.max(1),
    });
    let capabilities = AgentCapabilities {
        node_role: if leader.is_some() {
            NodeRole::Leader
        } else {
            NodeRole::Worker
        },
        region: cli.region,
        zone: cli.zone,
        currency: cli.currency,
        private_networks: cli.private_network.into_iter().collect::<BTreeSet<_>>(),
        storage_free_bytes: cli.storage_free_bytes,
        ingress_mbps: cli.ingress_mbps,
        egress_mbps: cli.egress_mbps,
        load: cli.load,
        idle_price_per_gib: cli.idle_price_per_gib,
        busy_price_per_gib: cli.busy_price_per_gib,
        idle_start_hour: cli.idle_start_hour,
        idle_end_hour: cli.idle_end_hour,
        utc_offset_minutes: cli.utc_offset_minutes,
        relay: cli.relay,
        leader,
    };
    let mut listen = cli.listen;
    if listen.is_empty() {
        listen.push("/ip4/0.0.0.0/tcp/0".parse()?);
        listen.push("/ip4/0.0.0.0/udp/0/quic-v1".parse()?);
    }

    let membership =
        MembershipManager::open(&cli.state_dir, &network_id, keypair.public().to_peer_id())?;
    let node_options = NodeOptions {
        keypair,
        network_id,
        name: cli.name,
        listen,
        bootstrap,
        capabilities,
        store,
        mailbox,
        allowed_peers: cli.allow_peer.into_iter().collect::<HashSet<_>>(),
        allow_all_peers: cli.allow_all_peers,
        membership,
    };

    match cli.command {
        Command::Id => unreachable!(),
        Command::Invite { ttl_seconds } => print_rpc(
            ipc::call(
                &cli.state_dir,
                "invite.create",
                serde_json::json!({"ttl_seconds":ttl_seconds}),
            )
            .await,
        ),
        Command::Join { .. } => {
            print_rpc(network::join(node_options, join_ticket.expect("join ticket parsed")).await)
        }
        Command::Daemon {
            control_listen,
            allow_source_delete,
        } => {
            network::daemon(network::DaemonOptions {
                node: node_options,
                state_dir: cli.state_dir,
                control_listen,
                allow_source_delete,
            })
            .await
        }
        Command::Status => {
            print_rpc(ipc::call(&cli.state_dir, "status", serde_json::json!({})).await)
        }
        Command::Peers => {
            print_rpc(ipc::call(&cli.state_dir, "peers", serde_json::json!({})).await)
        }
        Command::Publish { path } => {
            print_rpc(ipc::call(&cli.state_dir, "publish", serde_json::json!({"path":path})).await)
        }
        Command::Message {
            peer_id,
            text,
            ttl_seconds,
        } => {
            send_rpc(
                &cli.state_dir,
                peer_id,
                EnvelopeKind::Message,
                serde_json::json!({"text":text}),
                None,
                ttl_seconds,
            )
            .await
        }
        Command::Task {
            peer_id,
            prompt,
            ttl_seconds,
        } => {
            send_rpc(
                &cli.state_dir,
                peer_id,
                EnvelopeKind::Task,
                serde_json::json!({"prompt":prompt}),
                None,
                ttl_seconds,
            )
            .await
        }
        Command::Reply {
            peer_id,
            correlation_id,
            text,
            ttl_seconds,
        } => {
            send_rpc(
                &cli.state_dir,
                peer_id,
                EnvelopeKind::TaskResult,
                serde_json::json!({"text":text}),
                Some(correlation_id),
                ttl_seconds,
            )
            .await
        }
        Command::Cancel {
            peer_id,
            correlation_id,
            ttl_seconds,
        } => {
            send_rpc(
                &cli.state_dir,
                peer_id,
                EnvelopeKind::TaskCancel,
                serde_json::json!({"protocol":"dsh-leader/1","type":"task_cancel"}),
                Some(correlation_id),
                ttl_seconds,
            )
            .await
        }
        Command::Inbox { kind, limit } => print_rpc(
            ipc::call(
                &cli.state_dir,
                "inbox.list",
                serde_json::json!({"kind":kind.map(EnvelopeKind::from),"limit":limit}),
            )
            .await,
        ),
        Command::Ack { id } => {
            print_rpc(ipc::call(&cli.state_dir, "inbox.ack", serde_json::json!({"id":id})).await)
        }
        Command::Serve {
            provide,
            allow_source_delete,
        } => {
            for source in provide {
                let object = node_options.store.import(&source)?;
                println!(
                    "{}",
                    serde_json::json!({"event":"imported","source":source,"object":object})
                );
            }
            network::serve(node_options, allow_source_delete).await
        }
        Command::Discover { seconds } => {
            let peers = network::discover(node_options, seconds).await?;
            for peer in peers {
                println!(
                    "{}",
                    serde_json::json!({
                        "peer_id": peer.peer_id.to_string(),
                        "route": format!("{:?}", peer.route),
                        "observed_rtt_ms": peer.observed_rtt_ms,
                        "advertisement": peer.advertisement,
                        "inventory": peer.inventory,
                    })
                );
            }
            Ok(())
        }
        Command::Get {
            object_id,
            output,
            max_cost,
            optimize,
            discovery_seconds,
            request_source_delete,
        } => print_rpc(
            ipc::call(
                &cli.state_dir,
                "fetch",
                serde_json::json!({
                    "object_id":object_id,
                    "output":output,
                    "max_cost":max_cost,
                    "optimize":optimize.as_str(),
                    "discovery_seconds":discovery_seconds,
                    "request_source_delete":request_source_delete,
                }),
            )
            .await,
        ),
    }
}

async fn send_rpc(
    state_dir: &std::path::Path,
    peer_id: String,
    kind: EnvelopeKind,
    payload: serde_json::Value,
    correlation_id: Option<uuid::Uuid>,
    ttl_seconds: u64,
) -> Result<()> {
    print_rpc(
        ipc::call(
            state_dir,
            "send",
            serde_json::json!({
                "peer_id":peer_id,
                "kind":kind,
                "payload":payload,
                "correlation_id":correlation_id,
                "ttl_seconds":ttl_seconds,
            }),
        )
        .await,
    )
}

fn print_rpc(result: Result<serde_json::Value>) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(&result?)?);
    Ok(())
}
