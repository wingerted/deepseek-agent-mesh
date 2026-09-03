use std::collections::BTreeSet;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

pub const DEFAULT_CHUNK_SIZE: u64 = 1024 * 1024;
pub const ADVERTISEMENT_TTL_SECS: i64 = 90;

/// Aggregate capabilities offered by the sovereign Harness Leader on a node.
/// Local teammates are deliberately not advertised as mesh members.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct LeaderCapabilities {
    pub protocols: BTreeSet<String>,
    pub roles: BTreeSet<String>,
    pub workspace_aliases: BTreeSet<String>,
    pub team_enabled: bool,
    pub max_parallel_tasks: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentCapabilities {
    pub region: String,
    pub zone: String,
    pub currency: String,
    /// Equal tags mean that the two agents can use a private/free path.
    pub private_networks: BTreeSet<String>,
    pub storage_free_bytes: u64,
    pub ingress_mbps: f64,
    pub egress_mbps: f64,
    pub load: f64,
    pub idle_price_per_gib: f64,
    pub busy_price_per_gib: f64,
    pub idle_start_hour: u8,
    pub idle_end_hour: u8,
    pub utc_offset_minutes: i16,
    pub relay: bool,
    /// Present only when this daemon fronts a Harness Leader endpoint.
    #[serde(default)]
    pub leader: Option<LeaderCapabilities>,
}

impl AgentCapabilities {
    pub fn validate(&self) -> Result<(), String> {
        if self.region.trim().is_empty()
            || self.zone.trim().is_empty()
            || self.currency.trim().is_empty()
        {
            return Err("region, zone, and currency cannot be empty".into());
        }
        if !self.ingress_mbps.is_finite()
            || !self.egress_mbps.is_finite()
            || !self.load.is_finite()
            || !self.idle_price_per_gib.is_finite()
            || !self.busy_price_per_gib.is_finite()
        {
            return Err("bandwidth, load, and price values must be finite".into());
        }
        if !(0.0..=1.0).contains(&self.load) {
            return Err("load must be in [0, 1]".into());
        }
        if self.ingress_mbps <= 0.0 || self.egress_mbps <= 0.0 {
            return Err("bandwidth must be positive".into());
        }
        if self.idle_start_hour > 23 || self.idle_end_hour > 24 {
            return Err("idle hours are invalid".into());
        }
        if self.idle_price_per_gib < 0.0 || self.busy_price_per_gib < 0.0 {
            return Err("prices cannot be negative".into());
        }
        Ok(())
    }

    pub fn shares_private_network(&self, other: &Self) -> bool {
        !self.private_networks.is_disjoint(&other.private_networks)
    }

    pub fn egress_price_at(&self, now: DateTime<Utc>) -> f64 {
        let local = now + chrono::Duration::minutes(i64::from(self.utc_offset_minutes));
        let hour = chrono::Timelike::hour(&local) as u8;
        let idle = if self.idle_start_hour <= self.idle_end_hour {
            self.idle_start_hour <= hour && hour < self.idle_end_hour
        } else {
            hour >= self.idle_start_hour || hour < self.idle_end_hour
        };
        if idle {
            self.idle_price_per_gib
        } else {
            self.busy_price_per_gib
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentAdvertisement {
    pub network_id: String,
    pub peer_id: String,
    pub agent_name: String,
    pub sequence: u64,
    pub issued_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub capabilities: AgentCapabilities,
    pub listen_addresses: Vec<String>,
}

impl AgentAdvertisement {
    pub fn is_fresh(&self, now: DateTime<Utc>) -> bool {
        self.issued_at <= now + chrono::Duration::seconds(30) && self.expires_at > now
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ObjectSummary {
    pub object_id: String,
    pub size: u64,
    pub chunk_size: u64,
    pub chunk_count: u64,
}

impl ObjectSummary {
    pub fn new(object_id: String, size: u64, chunk_size: u64) -> Self {
        Self {
            object_id,
            size,
            chunk_size,
            chunk_count: size.div_ceil(chunk_size).max(1),
        }
    }
}
