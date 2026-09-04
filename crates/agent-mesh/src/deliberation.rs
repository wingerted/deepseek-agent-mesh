use std::{collections::BTreeSet, fs, path::PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const DELIBERATION_PROTOCOL: &str = "mesh-deliberation/1";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RoomPhase {
    Capability,
    Deliberation,
    Vote,
    Closed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ContributionKind {
    CapabilityBid,
    Proposal,
    Review,
    Vote,
    Abstain,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VoteChoice {
    Approve,
    Reject,
    Abstain,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RoomContract {
    pub topic: String,
    pub goal: String,
    pub participants: BTreeSet<String>,
    pub max_rounds: u8,
    pub max_speakers: u8,
    pub messages_per_leader_per_round: u8,
    pub max_message_bytes: u32,
    pub max_total_messages: u32,
    #[serde(default = "default_three")]
    pub quorum_numerator: u8,
    #[serde(default = "default_five")]
    pub quorum_denominator: u8,
    #[serde(default = "default_two")]
    pub approval_numerator: u8,
    #[serde(default = "default_three")]
    pub approval_denominator: u8,
}

const fn default_two() -> u8 {
    2
}

const fn default_three() -> u8 {
    3
}

const fn default_five() -> u8 {
    5
}

impl RoomContract {
    pub fn validate(&self) -> Result<()> {
        if self.topic.trim().is_empty() || self.goal.trim().is_empty() {
            bail!("room topic and goal are required")
        }
        if self.participants.is_empty() || self.participants.len() > 128 {
            bail!("a room requires 1..=128 Leader participants")
        }
        if !(1..=8).contains(&self.max_rounds) {
            bail!("max_rounds must be in 1..=8")
        }
        if self.max_speakers == 0 || usize::from(self.max_speakers) > self.participants.len() {
            bail!("max_speakers must be in 1..=participant count")
        }
        if !(1..=4).contains(&self.messages_per_leader_per_round) {
            bail!("messages_per_leader_per_round must be in 1..=4")
        }
        if !(256..=65_536).contains(&self.max_message_bytes) {
            bail!("max_message_bytes must be in 256..=65536")
        }
        if self.max_total_messages == 0 || self.max_total_messages > 4_096 {
            bail!("max_total_messages must be in 1..=4096")
        }
        if self.quorum_denominator == 0
            || self.quorum_numerator == 0
            || self.quorum_numerator > self.quorum_denominator
            || self.approval_denominator == 0
            || self.approval_numerator == 0
            || self.approval_numerator > self.approval_denominator
        {
            bail!("quorum and approval ratios must be positive fractions no greater than one")
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Contribution {
    pub id: Uuid,
    pub author_peer: String,
    pub round: u8,
    pub kind: ContributionKind,
    #[serde(default)]
    pub capability_used: BTreeSet<String>,
    pub confidence: f32,
    pub body: String,
    #[serde(default)]
    pub references: BTreeSet<Uuid>,
    #[serde(default)]
    pub vote: Option<VoteChoice>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DecisionCertificate {
    pub outcome: VoteChoice,
    pub eligible: u32,
    pub cast: u32,
    pub approvals: u32,
    pub rejections: u32,
    pub abstentions: u32,
    pub quorum_reached: bool,
    pub approval_reached: bool,
    pub contribution_ids: BTreeSet<Uuid>,
    pub closed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DeliberationRoom {
    pub id: Uuid,
    pub facilitator_peer: String,
    pub contract: RoomContract,
    pub phase: RoomPhase,
    pub round: u8,
    pub contributions: Vec<Contribution>,
    pub decision: Option<DecisionCertificate>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl DeliberationRoom {
    pub fn new(facilitator_peer: String, contract: RoomContract) -> Result<Self> {
        contract.validate()?;
        let now = Utc::now();
        Ok(Self {
            id: Uuid::new_v4(),
            facilitator_peer,
            contract,
            phase: RoomPhase::Capability,
            round: 0,
            contributions: Vec::new(),
            decision: None,
            created_at: now,
            updated_at: now,
        })
    }

    pub fn apply(&mut self, contribution: Contribution) -> Result<()> {
        if self.phase == RoomPhase::Closed {
            bail!("room is closed")
        }
        if !self
            .contract
            .participants
            .contains(&contribution.author_peer)
        {
            bail!("only declared Leader participants may speak")
        }
        if !contribution.confidence.is_finite() || !(0.0..=1.0).contains(&contribution.confidence) {
            bail!("confidence must be in [0, 1]")
        }
        if contribution.body.len() > self.contract.max_message_bytes as usize {
            bail!("contribution exceeds the room message budget")
        }
        if self.contributions.len() >= self.contract.max_total_messages as usize {
            bail!("room message budget is exhausted")
        }
        if self
            .contributions
            .iter()
            .any(|item| item.id == contribution.id)
        {
            return Ok(());
        }
        let expected_round = if self.phase == RoomPhase::Capability {
            0
        } else {
            self.round
        };
        if contribution.round != expected_round {
            bail!("contribution round does not match the active room round")
        }
        let kind_allowed = match self.phase {
            RoomPhase::Capability => matches!(
                contribution.kind,
                ContributionKind::CapabilityBid | ContributionKind::Abstain
            ),
            RoomPhase::Deliberation => matches!(
                contribution.kind,
                ContributionKind::Proposal | ContributionKind::Review | ContributionKind::Abstain
            ),
            RoomPhase::Vote => matches!(
                contribution.kind,
                ContributionKind::Vote | ContributionKind::Abstain
            ),
            RoomPhase::Closed => false,
        };
        if !kind_allowed {
            bail!("contribution kind is not allowed in the active room phase")
        }
        if contribution.kind == ContributionKind::Vote && contribution.vote.is_none() {
            bail!("a vote contribution requires a vote choice")
        }
        if contribution.kind != ContributionKind::Vote && contribution.vote.is_some() {
            bail!("only vote contributions may include a vote choice")
        }
        let author_count = self
            .contributions
            .iter()
            .filter(|item| {
                item.round == contribution.round
                    && kind_in_phase(item.kind, self.phase)
                    && item.author_peer == contribution.author_peer
            })
            .count();
        if author_count >= usize::from(self.contract.messages_per_leader_per_round) {
            bail!("Leader has exhausted its per-round speech budget")
        }
        let speakers: BTreeSet<_> = self
            .contributions
            .iter()
            .filter(|item| item.round == contribution.round && kind_in_phase(item.kind, self.phase))
            .map(|item| item.author_peer.as_str())
            .collect();
        if !speakers.contains(contribution.author_peer.as_str())
            && speakers.len() >= usize::from(self.contract.max_speakers)
        {
            bail!("round speaker budget is exhausted")
        }
        self.contributions.push(contribution);
        self.updated_at = Utc::now();
        Ok(())
    }

    pub fn advance(&mut self, facilitator_peer: &str) -> Result<()> {
        if facilitator_peer != self.facilitator_peer {
            bail!("only the room facilitator may advance the state machine")
        }
        match self.phase {
            RoomPhase::Capability => {
                self.phase = RoomPhase::Deliberation;
                self.round = 1;
            }
            RoomPhase::Deliberation if self.round < self.contract.max_rounds => {
                self.round += 1;
            }
            RoomPhase::Deliberation => self.phase = RoomPhase::Vote,
            RoomPhase::Vote => self.close(),
            RoomPhase::Closed => bail!("room is already closed"),
        }
        self.updated_at = Utc::now();
        Ok(())
    }

    fn close(&mut self) {
        let votes: Vec<_> = self
            .contributions
            .iter()
            .filter(|item| item.round == self.round && item.kind == ContributionKind::Vote)
            .collect();
        let approvals = votes
            .iter()
            .filter(|item| item.vote == Some(VoteChoice::Approve))
            .count() as u32;
        let rejections = votes
            .iter()
            .filter(|item| item.vote == Some(VoteChoice::Reject))
            .count() as u32;
        let abstentions = votes
            .iter()
            .filter(|item| item.vote == Some(VoteChoice::Abstain))
            .count() as u32;
        let cast = votes.len() as u32;
        let eligible = self.contract.participants.len() as u32;
        let quorum_reached = ratio_reached(
            cast,
            eligible,
            self.contract.quorum_numerator,
            self.contract.quorum_denominator,
        );
        let decisive = approvals + rejections;
        let approval_reached = quorum_reached
            && decisive > 0
            && ratio_reached(
                approvals,
                decisive,
                self.contract.approval_numerator,
                self.contract.approval_denominator,
            );
        let outcome = if approval_reached {
            VoteChoice::Approve
        } else {
            VoteChoice::Reject
        };
        self.decision = Some(DecisionCertificate {
            outcome,
            eligible,
            cast,
            approvals,
            rejections,
            abstentions,
            quorum_reached,
            approval_reached,
            contribution_ids: votes.iter().map(|item| item.id).collect(),
            closed_at: Utc::now(),
        });
        self.phase = RoomPhase::Closed;
    }
}

fn kind_in_phase(kind: ContributionKind, phase: RoomPhase) -> bool {
    match phase {
        RoomPhase::Capability => matches!(
            kind,
            ContributionKind::CapabilityBid | ContributionKind::Abstain
        ),
        RoomPhase::Deliberation => matches!(
            kind,
            ContributionKind::Proposal | ContributionKind::Review | ContributionKind::Abstain
        ),
        RoomPhase::Vote => matches!(kind, ContributionKind::Vote | ContributionKind::Abstain),
        RoomPhase::Closed => false,
    }
}

fn ratio_reached(
    numerator: u32,
    denominator: u32,
    threshold_numerator: u8,
    threshold_denominator: u8,
) -> bool {
    denominator > 0
        && numerator * u32::from(threshold_denominator)
            >= denominator * u32::from(threshold_numerator)
}

#[derive(Debug, Clone)]
pub struct RoomStore {
    root: PathBuf,
}

impl RoomStore {
    pub fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        fs::create_dir_all(&root)?;
        Ok(Self { root })
    }

    pub fn create(&self, room: &DeliberationRoom) -> Result<()> {
        let path = self.path(room.id);
        if path.exists() {
            bail!("room {} already exists", room.id)
        }
        self.write(room)
    }

    pub fn get(&self, id: Uuid) -> Result<DeliberationRoom> {
        let path = self.path(id);
        serde_json::from_slice(
            &fs::read(&path).with_context(|| format!("room {id} was not found"))?,
        )
        .with_context(|| format!("room {id} is corrupt"))
    }

    pub fn save(&self, room: &DeliberationRoom) -> Result<()> {
        if !self.path(room.id).exists() {
            bail!("room {} was not found", room.id)
        }
        self.write(room)
    }

    pub fn list(&self) -> Result<Vec<DeliberationRoom>> {
        let mut rooms = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            if entry.file_type()?.is_file()
                && entry
                    .path()
                    .extension()
                    .is_some_and(|value| value == "json")
            {
                rooms.push(serde_json::from_slice(&fs::read(entry.path())?)?);
            }
        }
        rooms.sort_by(|left: &DeliberationRoom, right: &DeliberationRoom| {
            right.updated_at.cmp(&left.updated_at)
        });
        Ok(rooms)
    }

    fn write(&self, room: &DeliberationRoom) -> Result<()> {
        let target = self.path(room.id);
        let temporary = target.with_extension("json.tmp");
        fs::write(&temporary, serde_json::to_vec_pretty(room)?)?;
        fs::rename(temporary, target)?;
        Ok(())
    }

    fn path(&self, id: Uuid) -> PathBuf {
        self.root.join(format!("{id}.json"))
    }

    pub fn ingest_payload(
        &self,
        envelope_id: Uuid,
        from_peer: &str,
        payload: &serde_json::Value,
    ) -> Result<DeliberationRoom> {
        if payload.get("protocol").and_then(serde_json::Value::as_str)
            != Some(DELIBERATION_PROTOCOL)
            || payload.get("type").and_then(serde_json::Value::as_str) != Some("room_submission")
        {
            bail!("not a mesh deliberation submission")
        }
        let room_id = payload
            .get("room_id")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| anyhow!("room_submission requires room_id"))?;
        let mut room = self.get(Uuid::parse_str(room_id)?)?;
        let mut contribution: Contribution = serde_json::from_value(
            payload
                .get("contribution")
                .cloned()
                .ok_or_else(|| anyhow!("room_submission requires contribution"))?,
        )?;
        contribution.id = envelope_id;
        contribution.author_peer = from_peer.to_owned();
        room.apply(contribution)?;
        self.save(&room)?;
        Ok(room)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn contract() -> RoomContract {
        RoomContract {
            topic: "Choose transport".into(),
            goal: "Produce one bounded decision".into(),
            participants: BTreeSet::from(["a".into(), "b".into(), "c".into()]),
            max_rounds: 2,
            max_speakers: 3,
            messages_per_leader_per_round: 1,
            max_message_bytes: 1024,
            max_total_messages: 16,
            quorum_numerator: 3,
            quorum_denominator: 5,
            approval_numerator: 2,
            approval_denominator: 3,
        }
    }

    fn contribution(
        author: &str,
        round: u8,
        kind: ContributionKind,
        vote: Option<VoteChoice>,
    ) -> Contribution {
        Contribution {
            id: Uuid::new_v4(),
            author_peer: author.into(),
            round,
            kind,
            capability_used: BTreeSet::from(["network".into()]),
            confidence: 0.8,
            body: "bounded statement".into(),
            references: BTreeSet::new(),
            vote,
            created_at: Utc::now(),
        }
    }

    #[test]
    fn bounded_room_reaches_a_decision() {
        let mut room = DeliberationRoom::new("watcher".into(), contract()).unwrap();
        for peer in ["a", "b", "c"] {
            room.apply(contribution(peer, 0, ContributionKind::CapabilityBid, None))
                .unwrap();
        }
        assert!(
            room.apply(contribution("a", 0, ContributionKind::CapabilityBid, None))
                .is_err()
        );
        room.advance("watcher").unwrap();
        room.apply(contribution("a", 1, ContributionKind::Proposal, None))
            .unwrap();
        room.advance("watcher").unwrap();
        room.apply(contribution("b", 2, ContributionKind::Review, None))
            .unwrap();
        room.advance("watcher").unwrap();
        for (peer, vote) in [
            ("a", VoteChoice::Approve),
            ("b", VoteChoice::Approve),
            ("c", VoteChoice::Reject),
        ] {
            room.apply(contribution(peer, 2, ContributionKind::Vote, Some(vote)))
                .unwrap();
        }
        room.advance("watcher").unwrap();
        assert_eq!(room.phase, RoomPhase::Closed);
        assert_eq!(room.decision.as_ref().unwrap().outcome, VoteChoice::Approve);
        assert!(room.decision.as_ref().unwrap().quorum_reached);
        assert!(room.decision.as_ref().unwrap().approval_reached);
    }

    #[test]
    fn store_is_atomic_and_ingest_uses_authenticated_sender() {
        let temp = tempfile::tempdir().unwrap();
        let store = RoomStore::open(temp.path()).unwrap();
        let room = DeliberationRoom::new("watcher".into(), contract()).unwrap();
        let room_id = room.id;
        store.create(&room).unwrap();
        let claimed = contribution("forged", 0, ContributionKind::CapabilityBid, None);
        let payload = serde_json::json!({
            "protocol": DELIBERATION_PROTOCOL,
            "type": "room_submission",
            "room_id": room_id,
            "contribution": claimed,
        });
        store.ingest_payload(Uuid::new_v4(), "a", &payload).unwrap();
        let saved = store.get(room_id).unwrap();
        assert_eq!(saved.contributions[0].author_peer, "a");
    }

    #[test]
    fn decision_ratios_are_exact() {
        assert!(ratio_reached(2, 3, 2, 3));
        assert!(!ratio_reached(1, 2, 2, 3));
        assert!(ratio_reached(3, 5, 3, 5));
    }
}
