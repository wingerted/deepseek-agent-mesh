use std::{cmp::Ordering, str::FromStr};

use anyhow::{Result, bail};
use chrono::{DateTime, Utc};
use libp2p::PeerId;

use crate::model::{AgentAdvertisement, AgentCapabilities, ObjectSummary};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OptimizeFor {
    Cost,
    Speed,
    Balanced,
}

impl FromStr for OptimizeFor {
    type Err = anyhow::Error;

    fn from_str(value: &str) -> Result<Self> {
        match value {
            "cost" => Ok(Self::Cost),
            "speed" => Ok(Self::Speed),
            "balanced" => Ok(Self::Balanced),
            _ => bail!("optimize must be cost, speed, or balanced"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum RouteKind {
    DirectPrivate,
    DirectPublic,
    Relayed,
}

#[derive(Debug, Clone)]
pub struct Candidate {
    pub peer_id: PeerId,
    pub advertisement: AgentAdvertisement,
    pub object: ObjectSummary,
    pub route: RouteKind,
    pub observed_rtt_ms: f64,
}

#[derive(Debug, Clone)]
pub struct TransferPlan {
    pub peer_id: PeerId,
    pub route: RouteKind,
    pub estimated_cost: f64,
    pub estimated_seconds: f64,
    pub reason: String,
    pub source_delete_pending: Option<bool>,
}

pub fn choose_best(
    local: &AgentCapabilities,
    candidates: &[Candidate],
    max_cost: f64,
    optimize: OptimizeFor,
    now: DateTime<Utc>,
) -> Option<TransferPlan> {
    if !max_cost.is_finite() || max_cost < 0.0 {
        return None;
    }
    let mut plans: Vec<_> = candidates
        .iter()
        .filter_map(|candidate| {
            if !candidate.advertisement.is_fresh(now)
                || candidate.advertisement.capabilities.validate().is_err()
            {
                return None;
            }
            let remote = &candidate.advertisement.capabilities;
            if remote.currency != local.currency || !candidate.observed_rtt_ms.is_finite() {
                return None;
            }
            let route = match candidate.route {
                RouteKind::DirectPrivate if local.shares_private_network(remote) => {
                    RouteKind::DirectPrivate
                }
                RouteKind::DirectPrivate => RouteKind::DirectPublic,
                other => other,
            };
            let egress_cost = if route == RouteKind::DirectPrivate {
                0.0
            } else {
                candidate.object.size as f64 / 1024_f64.powi(3) * remote.egress_price_at(now)
            };
            let relay_cost = if route == RouteKind::Relayed {
                // Unknown relay billing is deliberately pessimistic instead of treated as free.
                candidate.object.size as f64 / 1024_f64.powi(3) * 0.10
            } else {
                0.0
            };
            let cost = egress_cost + relay_cost;
            if cost > max_cost + f64::EPSILON {
                return None;
            }
            let effective_mbps = local.ingress_mbps.min(remote.egress_mbps).max(0.001);
            let seconds = candidate.object.size as f64 * 8.0 / (effective_mbps * 1_000_000.0)
                * (1.0 + remote.load)
                + candidate.observed_rtt_ms / 1000.0;
            Some(TransferPlan {
                peer_id: candidate.peer_id,
                route,
                estimated_cost: cost,
                estimated_seconds: seconds,
                reason: format!(
                    "route={route:?}, cost={cost:.6}, eta={seconds:.2}s, load={:.2}",
                    remote.load
                ),
                source_delete_pending: None,
            })
        })
        .collect();

    plans.sort_by(|a, b| compare(a, b, max_cost, optimize));
    plans.into_iter().next()
}

fn compare(a: &TransferPlan, b: &TransferPlan, max_cost: f64, optimize: OptimizeFor) -> Ordering {
    // A private path is never displaced by a metered path. Within the same path class,
    // the caller chooses whether money, time, or a normalized blend dominates.
    a.route.cmp(&b.route).then_with(|| match optimize {
        OptimizeFor::Cost => total_cmp(a.estimated_cost, b.estimated_cost)
            .then_with(|| total_cmp(a.estimated_seconds, b.estimated_seconds)),
        OptimizeFor::Speed => total_cmp(a.estimated_seconds, b.estimated_seconds)
            .then_with(|| total_cmp(a.estimated_cost, b.estimated_cost)),
        OptimizeFor::Balanced => {
            let budget = max_cost.max(0.000_001);
            let a_score = a.estimated_cost / budget + a.estimated_seconds / 3600.0;
            let b_score = b.estimated_cost / budget + b.estimated_seconds / 3600.0;
            total_cmp(a_score, b_score)
        }
    })
}

fn total_cmp(a: f64, b: f64) -> Ordering {
    a.total_cmp(&b)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use chrono::TimeZone;
    use libp2p::identity;

    use super::*;

    fn capabilities(network: &str, egress: f64, price: f64) -> AgentCapabilities {
        AgentCapabilities {
            node_role: crate::model::NodeRole::Worker,
            region: "cn-sh2".into(),
            zone: "a".into(),
            currency: "CNY".into(),
            private_networks: BTreeSet::from([network.into()]),
            storage_free_bytes: 1_000_000,
            ingress_mbps: 1_000.0,
            egress_mbps: egress,
            load: 0.0,
            idle_price_per_gib: price,
            busy_price_per_gib: price,
            idle_start_hour: 0,
            idle_end_hour: 8,
            utc_offset_minutes: 480,
            relay: false,
            leader: None,
        }
    }

    fn candidate(network: &str, egress: f64, price: f64, size: u64, route: RouteKind) -> Candidate {
        let now = Utc.with_ymd_and_hms(2026, 9, 3, 0, 0, 0).unwrap();
        let peer_id = identity::Keypair::generate_ed25519().public().to_peer_id();
        Candidate {
            peer_id,
            advertisement: AgentAdvertisement {
                network_id: "test".into(),
                peer_id: peer_id.to_string(),
                agent_name: "test".into(),
                sequence: 1,
                issued_at: now,
                expires_at: now + chrono::Duration::minutes(1),
                capabilities: capabilities(network, egress, price),
                listen_addresses: vec![],
            },
            object: ObjectSummary::new("a".repeat(64), size, 1024),
            route,
            observed_rtt_ms: 1.0,
        }
    }

    #[test]
    fn private_route_wins_without_egress_cost() {
        let now = Utc.with_ymd_and_hms(2026, 9, 3, 0, 0, 0).unwrap();
        let local = capabilities("vpc-a", 100.0, 0.0);
        let private = candidate(
            "vpc-a",
            50.0,
            0.45,
            1024 * 1024 * 1024,
            RouteKind::DirectPrivate,
        );
        let public = candidate(
            "vpc-b",
            1000.0,
            0.01,
            1024 * 1024 * 1024,
            RouteKind::DirectPublic,
        );
        let plan = choose_best(
            &local,
            &[public, private.clone()],
            1.0,
            OptimizeFor::Speed,
            now,
        )
        .unwrap();
        assert_eq!(plan.peer_id, private.peer_id);
        assert_eq!(plan.estimated_cost, 0.0);
    }

    #[test]
    fn hard_budget_filters_expensive_peer() {
        let now = Utc.with_ymd_and_hms(2026, 9, 3, 0, 0, 0).unwrap();
        let local = capabilities("local", 1000.0, 0.0);
        let candidate = candidate(
            "remote",
            1000.0,
            0.45,
            1024 * 1024 * 1024,
            RouteKind::DirectPublic,
        );
        assert!(choose_best(&local, &[candidate], 0.44, OptimizeFor::Cost, now).is_none());
    }

    #[test]
    fn self_declared_private_tag_does_not_make_a_public_path_free() {
        let now = Utc.with_ymd_and_hms(2026, 9, 3, 0, 0, 0).unwrap();
        let local = capabilities("same-tag", 1000.0, 0.0);
        let remote = candidate(
            "same-tag",
            1000.0,
            0.45,
            1024 * 1024 * 1024,
            RouteKind::DirectPublic,
        );
        assert!(choose_best(&local, &[remote], 0.0, OptimizeFor::Cost, now).is_none());
    }

    #[test]
    fn different_currencies_are_not_compared() {
        let now = Utc.with_ymd_and_hms(2026, 9, 3, 0, 0, 0).unwrap();
        let local = capabilities("local", 1000.0, 0.0);
        let mut remote = candidate("remote", 1000.0, 0.01, 1024, RouteKind::DirectPublic);
        remote.advertisement.capabilities.currency = "USD".into();
        assert!(choose_best(&local, &[remote], 1.0, OptimizeFor::Cost, now).is_none());
    }

    #[test]
    fn non_finite_budget_is_rejected() {
        let now = Utc.with_ymd_and_hms(2026, 9, 3, 0, 0, 0).unwrap();
        let local = capabilities("local", 1000.0, 0.0);
        let remote = candidate("remote", 1000.0, 0.01, 1024, RouteKind::DirectPublic);
        assert!(choose_best(&local, &[remote], f64::NAN, OptimizeFor::Cost, now).is_none());
    }
}
