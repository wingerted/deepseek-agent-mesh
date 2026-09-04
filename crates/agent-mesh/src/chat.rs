use std::{collections::BTreeSet, fs, path::PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const CHAT_PROTOCOL: &str = "mesh-chat/1";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChatAuthorRole {
    Watcher,
    Leader,
    System,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChatMessageKind {
    Prompt,
    Reply,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChatContract {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub participants: BTreeSet<String>,
    pub max_turns: u32,
    pub max_responders_per_turn: u8,
    pub max_message_bytes: u32,
    pub max_total_messages: u32,
}

impl ChatContract {
    pub fn validate(&self) -> Result<()> {
        if self.name.trim().is_empty() || self.name.len() > 160 {
            bail!("chat name must contain 1..=160 bytes")
        }
        if self.description.len() > 2_048 {
            bail!("chat description exceeds 2048 bytes")
        }
        if self.participants.is_empty() || self.participants.len() > 128 {
            bail!("a chat requires 1..=128 Leader participants")
        }
        if !(1..=1_000).contains(&self.max_turns) {
            bail!("max_turns must be in 1..=1000")
        }
        if self.max_responders_per_turn == 0
            || usize::from(self.max_responders_per_turn) > self.participants.len()
        {
            bail!("max_responders_per_turn must be in 1..=participant count")
        }
        if !(256..=65_536).contains(&self.max_message_bytes) {
            bail!("max_message_bytes must be in 256..=65536")
        }
        if !(2..=16_384).contains(&self.max_total_messages) {
            bail!("max_total_messages must be in 2..=16384")
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChatMessage {
    pub id: Uuid,
    pub author_peer: String,
    pub author_role: ChatAuthorRole,
    pub kind: ChatMessageKind,
    pub turn: u32,
    pub body: String,
    #[serde(default)]
    pub reply_to: Option<Uuid>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChatRoom {
    pub id: Uuid,
    pub host_peer: String,
    pub contract: ChatContract,
    pub open: bool,
    pub turn: u32,
    pub messages: Vec<ChatMessage>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl ChatRoom {
    pub fn new(host_peer: String, contract: ChatContract) -> Result<Self> {
        contract.validate()?;
        let now = Utc::now();
        Ok(Self {
            id: Uuid::new_v4(),
            host_peer,
            contract,
            open: true,
            turn: 0,
            messages: Vec::new(),
            created_at: now,
            updated_at: now,
        })
    }

    pub fn post(&mut self, host_peer: &str, body: String) -> Result<()> {
        if host_peer != self.host_peer {
            bail!("only the chat host may post prompts")
        }
        if !self.open {
            bail!("chat is closed")
        }
        let body = body.trim().to_owned();
        self.validate_body(&body)?;
        if self.turn >= self.contract.max_turns {
            bail!("chat turn budget is exhausted")
        }
        if self.messages.len() >= self.contract.max_total_messages as usize {
            bail!("chat message budget is exhausted")
        }
        self.turn += 1;
        self.messages.push(ChatMessage {
            id: Uuid::new_v4(),
            author_peer: host_peer.to_owned(),
            author_role: ChatAuthorRole::Watcher,
            kind: ChatMessageKind::Prompt,
            turn: self.turn,
            body,
            reply_to: None,
            created_at: Utc::now(),
        });
        self.updated_at = Utc::now();
        Ok(())
    }

    pub fn apply_reply(&mut self, mut message: ChatMessage) -> Result<()> {
        if !self.open {
            bail!("chat is closed")
        }
        if !self.contract.participants.contains(&message.author_peer) {
            bail!("only declared Leader participants may reply")
        }
        if message.turn == 0 || message.turn > self.turn {
            bail!("chat reply references an unknown turn")
        }
        self.validate_body(message.body.trim())?;
        let prompt = self
            .messages
            .iter()
            .rev()
            .find(|item| item.turn == message.turn && item.kind == ChatMessageKind::Prompt)
            .ok_or_else(|| anyhow!("referenced chat prompt was not found"))?;
        if message.reply_to != Some(prompt.id) {
            bail!("chat reply does not reference the active prompt")
        }
        if self.messages.iter().any(|item| item.id == message.id) {
            return Ok(());
        }
        if self.messages.iter().any(|item| {
            item.turn == message.turn
                && item.kind == ChatMessageKind::Reply
                && item.author_peer == message.author_peer
        }) {
            bail!("Leader has already replied in this chat turn")
        }
        let reply_count = self
            .messages
            .iter()
            .filter(|item| item.turn == message.turn && item.kind == ChatMessageKind::Reply)
            .count();
        if reply_count >= usize::from(self.contract.max_responders_per_turn) {
            bail!("chat responder budget is exhausted")
        }
        if self.messages.len() >= self.contract.max_total_messages as usize {
            bail!("chat message budget is exhausted")
        }
        message.author_role = ChatAuthorRole::Leader;
        message.kind = ChatMessageKind::Reply;
        message.body = message.body.trim().to_owned();
        self.messages.push(message);
        self.updated_at = Utc::now();
        Ok(())
    }

    pub fn close(&mut self, host_peer: &str) -> Result<()> {
        if host_peer != self.host_peer {
            bail!("only the chat host may close the room")
        }
        self.open = false;
        self.updated_at = Utc::now();
        Ok(())
    }

    fn validate_body(&self, body: &str) -> Result<()> {
        if body.is_empty() {
            bail!("chat message cannot be empty")
        }
        if body.len() > self.contract.max_message_bytes as usize {
            bail!("chat message exceeds the byte budget")
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct ChatStore {
    root: PathBuf,
}

impl ChatStore {
    pub fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        fs::create_dir_all(&root)?;
        Ok(Self { root })
    }

    pub fn create(&self, room: &ChatRoom) -> Result<()> {
        if self.path(room.id).exists() {
            bail!("chat {} already exists", room.id)
        }
        self.write(room)
    }

    pub fn get(&self, id: Uuid) -> Result<ChatRoom> {
        let path = self.path(id);
        serde_json::from_slice(
            &fs::read(&path).with_context(|| format!("chat {id} was not found"))?,
        )
        .with_context(|| format!("chat {id} is corrupt"))
    }

    pub fn save(&self, room: &ChatRoom) -> Result<()> {
        if !self.path(room.id).exists() {
            bail!("chat {} was not found", room.id)
        }
        self.write(room)
    }

    pub fn list(&self) -> Result<Vec<ChatRoom>> {
        let mut rooms: Vec<ChatRoom> = Vec::new();
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
        rooms.sort_by_key(|room| std::cmp::Reverse(room.updated_at));
        Ok(rooms)
    }

    pub fn ingest_payload(
        &self,
        envelope_id: Uuid,
        from_peer: &str,
        payload: &serde_json::Value,
    ) -> Result<ChatRoom> {
        if payload.get("protocol").and_then(serde_json::Value::as_str) != Some(CHAT_PROTOCOL)
            || payload.get("type").and_then(serde_json::Value::as_str) != Some("chat_reply")
        {
            bail!("not a mesh chat reply")
        }
        let room_id = payload
            .get("room_id")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| anyhow!("chat_reply requires room_id"))?;
        let mut room = self.get(Uuid::parse_str(room_id)?)?;
        let message = ChatMessage {
            id: envelope_id,
            author_peer: from_peer.to_owned(),
            author_role: ChatAuthorRole::Leader,
            kind: ChatMessageKind::Reply,
            turn: payload
                .get("turn")
                .and_then(serde_json::Value::as_u64)
                .and_then(|value| u32::try_from(value).ok())
                .ok_or_else(|| anyhow!("chat_reply requires a valid turn"))?,
            body: payload
                .get("body")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| anyhow!("chat_reply requires body"))?
                .to_owned(),
            reply_to: payload
                .get("reply_to")
                .and_then(serde_json::Value::as_str)
                .map(Uuid::parse_str)
                .transpose()?,
            created_at: Utc::now(),
        };
        room.apply_reply(message)?;
        self.save(&room)?;
        Ok(room)
    }

    fn write(&self, room: &ChatRoom) -> Result<()> {
        let target = self.path(room.id);
        let temporary = target.with_extension("json.tmp");
        fs::write(&temporary, serde_json::to_vec_pretty(room)?)?;
        fs::rename(temporary, target)?;
        Ok(())
    }

    fn path(&self, id: Uuid) -> PathBuf {
        self.root.join(format!("{id}.json"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn contract() -> ChatContract {
        ChatContract {
            name: "Mesh lounge".into(),
            description: "Leaders coordinate here".into(),
            participants: BTreeSet::from(["a".into(), "b".into(), "c".into()]),
            max_turns: 100,
            max_responders_per_turn: 2,
            max_message_bytes: 1024,
            max_total_messages: 256,
        }
    }

    fn reply(author: &str, turn: u32, reply_to: Uuid) -> ChatMessage {
        ChatMessage {
            id: Uuid::new_v4(),
            author_peer: author.into(),
            author_role: ChatAuthorRole::Leader,
            kind: ChatMessageKind::Reply,
            turn,
            body: "one useful chat reply".into(),
            reply_to: Some(reply_to),
            created_at: Utc::now(),
        }
    }

    #[test]
    fn room_is_a_bounded_chat_not_a_phase_machine() {
        let mut room = ChatRoom::new("watcher".into(), contract()).unwrap();
        room.post("watcher", "hello leaders".into()).unwrap();
        let prompt = room.messages[0].id;
        room.apply_reply(reply("a", 1, prompt)).unwrap();
        assert!(room.apply_reply(reply("a", 1, prompt)).is_err());
        room.post("watcher", "next message".into()).unwrap();
        room.apply_reply(reply("b", 1, prompt)).unwrap();
        assert!(room.apply_reply(reply("c", 1, prompt)).is_err());
        assert_eq!(room.turn, 2);
        assert_eq!(room.messages.len(), 4);
    }

    #[test]
    fn store_uses_authenticated_reply_author() {
        let temp = tempfile::tempdir().unwrap();
        let store = ChatStore::open(temp.path()).unwrap();
        let mut room = ChatRoom::new("watcher".into(), contract()).unwrap();
        room.post("watcher", "hello".into()).unwrap();
        let room_id = room.id;
        let prompt_id = room.messages[0].id;
        store.create(&room).unwrap();
        let payload = serde_json::json!({
            "protocol": CHAT_PROTOCOL,
            "type": "chat_reply",
            "room_id": room_id,
            "turn": 1,
            "reply_to": prompt_id,
            "body": "authenticated reply",
        });
        store.ingest_payload(Uuid::new_v4(), "a", &payload).unwrap();
        assert_eq!(store.get(room_id).unwrap().messages[1].author_peer, "a");
    }
}
