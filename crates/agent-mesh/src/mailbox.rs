use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail};
use uuid::Uuid;

use crate::envelope::{Envelope, EnvelopeKind};

#[derive(Debug, Clone)]
pub struct Mailbox {
    root: PathBuf,
}

impl Mailbox {
    pub fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        fs::create_dir_all(root.join("inbox"))?;
        fs::create_dir_all(root.join("processed"))?;
        Ok(Self { root })
    }

    /// Persist before the network ACK. `create_new` also makes retransmission idempotent.
    pub fn put(&self, envelope: &Envelope) -> Result<()> {
        let target = self.path("inbox", envelope.id);
        if target.exists() || self.path("processed", envelope.id).exists() {
            return Ok(());
        }
        let temporary = self
            .root
            .join("inbox")
            .join(format!(".{}.tmp", envelope.id));
        let bytes = serde_json::to_vec(envelope)?;
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
        {
            Ok(mut file) => {
                file.write_all(&bytes)?;
                file.sync_all()?;
                fs::rename(&temporary, &target)?;
                Ok(())
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    pub fn list(&self, kind: Option<EnvelopeKind>, limit: usize) -> Result<Vec<Envelope>> {
        let mut entries: Vec<_> = fs::read_dir(self.root.join("inbox"))?
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
            .collect();
        entries.sort_by_key(|entry| entry.file_name());
        let mut envelopes = Vec::new();
        for entry in entries {
            let envelope: Envelope = serde_json::from_slice(
                &fs::read(entry.path())
                    .with_context(|| format!("failed reading {}", entry.path().display()))?,
            )?;
            if !envelope.is_fresh() {
                self.ack(envelope.id)?;
                continue;
            }
            if kind.is_none_or(|expected| expected == envelope.kind) {
                envelopes.push(envelope);
            }
            if envelopes.len() >= limit.clamp(1, 1000) {
                break;
            }
        }
        Ok(envelopes)
    }

    pub fn ack(&self, id: Uuid) -> Result<()> {
        let source = self.path("inbox", id);
        let target = self.path("processed", id);
        if target.exists() {
            return Ok(());
        }
        if !source.exists() {
            bail!("inbox envelope {id} not found")
        }
        fs::rename(source, target)?;
        Ok(())
    }

    fn path(&self, bucket: &str, id: Uuid) -> PathBuf {
        self.root.join(bucket).join(format!("{id}.json"))
    }

    #[allow(dead_code)]
    pub fn root(&self) -> &Path {
        &self.root
    }
}

#[cfg(test)]
mod tests {
    use chrono::{Duration, Utc};
    use serde_json::json;

    use super::*;

    fn envelope(kind: EnvelopeKind) -> Envelope {
        Envelope {
            id: Uuid::new_v4(),
            network_id: "test".into(),
            from_peer: "a".into(),
            to_peer: "b".into(),
            kind,
            correlation_id: None,
            created_at: Utc::now(),
            expires_at: Utc::now() + Duration::minutes(1),
            payload: json!({"text":"hello"}),
        }
    }

    #[test]
    fn durable_idempotent_put_and_ack() {
        let root = tempfile::tempdir().unwrap();
        let mailbox = Mailbox::open(root.path()).unwrap();
        let item = envelope(EnvelopeKind::Task);
        mailbox.put(&item).unwrap();
        mailbox.put(&item).unwrap();
        assert_eq!(mailbox.list(None, 10).unwrap().len(), 1);
        mailbox.ack(item.id).unwrap();
        assert!(mailbox.list(None, 10).unwrap().is_empty());
        mailbox.ack(item.id).unwrap();
    }
}
