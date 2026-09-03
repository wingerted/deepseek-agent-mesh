use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvelopeKind {
    Message,
    Task,
    TaskCancel,
    TaskProgress,
    TaskResult,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Envelope {
    pub id: Uuid,
    pub network_id: String,
    pub from_peer: String,
    pub to_peer: String,
    pub kind: EnvelopeKind,
    pub correlation_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub payload: Value,
}

impl Envelope {
    pub fn new(
        network_id: String,
        from_peer: String,
        to_peer: String,
        kind: EnvelopeKind,
        correlation_id: Option<Uuid>,
        ttl_seconds: u64,
        payload: Value,
    ) -> Self {
        let created_at = Utc::now();
        let ttl = i64::try_from(ttl_seconds.clamp(1, 7 * 24 * 60 * 60)).unwrap_or(604_800);
        Self {
            id: Uuid::new_v4(),
            network_id,
            from_peer,
            to_peer,
            kind,
            correlation_id,
            created_at,
            expires_at: created_at + Duration::seconds(ttl),
            payload,
        }
    }

    pub fn is_fresh(&self) -> bool {
        self.expires_at > Utc::now()
    }
}
