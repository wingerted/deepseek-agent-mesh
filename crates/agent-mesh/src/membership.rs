use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, anyhow, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::Utc;
use libp2p::{Multiaddr, PeerId, identity};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const JOIN_PREFIX: &str = "mesh1:";
const MEMBER_LIFETIME_SECS: i64 = 365 * 24 * 60 * 60;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MembershipCertificate {
    pub version: u8,
    pub network_id: String,
    pub peer_id: String,
    pub issuer_peer_id: String,
    pub issued_at: i64,
    pub expires_at: i64,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MembershipState {
    pub version: u8,
    pub network_id: String,
    pub root_peer_id: String,
    pub root_public_key: String,
    pub certificate: MembershipCertificate,
    #[serde(default)]
    pub bootstrap: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct JoinTicket {
    pub version: u8,
    pub network_id: String,
    pub issuer_peer_id: String,
    pub issuer_public_key: String,
    pub bootstrap: Vec<String>,
    pub token: String,
    pub expires_at: i64,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct InviteGrant {
    token_hash: String,
    expires_at: i64,
    #[serde(default)]
    used_by: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct InviteDatabase {
    grants: Vec<InviteGrant>,
}

#[derive(Debug)]
pub struct MembershipManager {
    state_dir: PathBuf,
    network_id: String,
    local_peer: PeerId,
    state: Option<MembershipState>,
}

impl JoinTicket {
    pub fn decode(code: &str) -> Result<Self> {
        let encoded = code
            .trim()
            .strip_prefix(JOIN_PREFIX)
            .ok_or_else(|| anyhow!("join code must start with {JOIN_PREFIX}"))?;
        let bytes = URL_SAFE_NO_PAD
            .decode(encoded)
            .context("join code is not valid base64url")?;
        let ticket: Self = serde_json::from_slice(&bytes).context("invalid join ticket")?;
        ticket.verify()?;
        Ok(ticket)
    }

    pub fn encode(&self) -> Result<String> {
        Ok(format!(
            "{JOIN_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(self)?)
        ))
    }

    pub fn bootstrap_addrs(&self) -> Result<Vec<Multiaddr>> {
        self.bootstrap
            .iter()
            .map(|address| {
                address
                    .parse::<Multiaddr>()
                    .with_context(|| format!("invalid bootstrap address {address}"))
            })
            .collect()
    }

    pub fn issuer(&self) -> Result<PeerId> {
        self.issuer_peer_id
            .parse()
            .context("invalid inviter peer ID")
    }

    pub fn verify(&self) -> Result<()> {
        if self.version != 1 || self.network_id.trim().is_empty() {
            bail!("unsupported or invalid join ticket")
        }
        if self.expires_at <= Utc::now().timestamp() {
            bail!("join ticket has expired")
        }
        if self.bootstrap.is_empty() {
            bail!("join ticket has no bootstrap address")
        }
        let issuer = self.issuer()?;
        let public = decode_public_key(&self.issuer_public_key)?;
        if public.to_peer_id() != issuer {
            bail!("join ticket public key does not match inviter")
        }
        for address in self.bootstrap_addrs()? {
            if address_peer(&address) != Some(issuer) {
                bail!("join ticket bootstrap address does not match inviter")
            }
        }
        let signature = URL_SAFE_NO_PAD
            .decode(&self.signature)
            .context("invalid join ticket signature encoding")?;
        if !public.verify(&ticket_payload(self)?, &signature) {
            bail!("join ticket signature is invalid")
        }
        Ok(())
    }
}

impl MembershipManager {
    pub fn open(
        state_dir: impl Into<PathBuf>,
        network_id: &str,
        local_peer: PeerId,
    ) -> Result<Self> {
        let state_dir = state_dir.into();
        let state = read_optional::<MembershipState>(&state_dir.join("membership.json"))?;
        if let Some(state) = &state {
            validate_state(state, local_peer)?;
            if state.network_id != network_id {
                bail!(
                    "configured network {} does not match persisted membership {}",
                    network_id,
                    state.network_id
                )
            }
        }
        Ok(Self {
            state_dir,
            network_id: network_id.to_owned(),
            local_peer,
            state,
        })
    }

    pub fn load(state_dir: &Path) -> Result<Option<MembershipState>> {
        read_optional(&state_dir.join("membership.json"))
    }

    pub fn certificate(&self) -> Option<MembershipCertificate> {
        self.state.as_ref().map(|state| state.certificate.clone())
    }

    pub fn state(&self) -> Option<&MembershipState> {
        self.state.as_ref()
    }

    pub fn create_invite(
        &mut self,
        identity: &identity::Keypair,
        bootstrap: Vec<String>,
        ttl_seconds: u64,
    ) -> Result<JoinTicket> {
        if bootstrap.is_empty() {
            bail!("cannot create an invite before the daemon has a listen address")
        }
        self.ensure_root(identity, bootstrap.clone())?;
        let state = self
            .state
            .as_ref()
            .expect("root membership was initialized");
        if state.root_peer_id != self.local_peer.to_string() {
            bail!("only the founding node can issue invitations in protocol v1")
        }
        let token = uuid::Uuid::new_v4().simple().to_string();
        let expires_at = Utc::now().timestamp() + ttl_seconds.clamp(60, 24 * 60 * 60) as i64;
        let mut ticket = JoinTicket {
            version: 1,
            network_id: self.network_id.clone(),
            issuer_peer_id: self.local_peer.to_string(),
            issuer_public_key: encode_public_key(&identity.public())?,
            bootstrap,
            token: token.clone(),
            expires_at,
            signature: String::new(),
        };
        ticket.signature = URL_SAFE_NO_PAD.encode(identity.sign(&ticket_payload(&ticket)?)?);
        let mut database = self.read_invites()?;
        database
            .grants
            .retain(|grant| grant.expires_at > Utc::now().timestamp() && grant.used_by.is_none());
        database.grants.push(InviteGrant {
            token_hash: token_hash(&token),
            expires_at,
            used_by: None,
        });
        self.write_invites(&database)?;
        Ok(ticket)
    }

    pub fn admit(
        &mut self,
        identity: &identity::Keypair,
        token: &str,
        peer: PeerId,
    ) -> Result<MembershipCertificate> {
        let state = self
            .state
            .as_ref()
            .ok_or_else(|| anyhow!("this node has not initialized a membership root"))?;
        if state.root_peer_id != self.local_peer.to_string() {
            bail!("this node cannot issue member certificates")
        }
        let mut database = self.read_invites()?;
        let now = Utc::now().timestamp();
        let grant = database
            .grants
            .iter_mut()
            .find(|grant| grant.token_hash == token_hash(token))
            .ok_or_else(|| anyhow!("unknown invitation"))?;
        if grant.expires_at <= now {
            bail!("invitation has expired")
        }
        if grant.used_by.is_some() {
            bail!("invitation has already been used")
        }
        let certificate = sign_certificate(identity, &self.network_id, peer, now)?;
        grant.used_by = Some(peer.to_string());
        self.write_invites(&database)?;
        Ok(certificate)
    }

    pub fn accept(
        &mut self,
        ticket: &JoinTicket,
        certificate: MembershipCertificate,
    ) -> Result<()> {
        ticket.verify()?;
        verify_certificate(
            &certificate,
            &ticket.network_id,
            self.local_peer,
            &ticket.issuer_peer_id,
            &ticket.issuer_public_key,
        )?;
        let state = MembershipState {
            version: 1,
            network_id: ticket.network_id.clone(),
            root_peer_id: ticket.issuer_peer_id.clone(),
            root_public_key: ticket.issuer_public_key.clone(),
            certificate,
            bootstrap: ticket.bootstrap.clone(),
        };
        write_private_json(&self.state_dir.join("membership.json"), &state)?;
        self.network_id = state.network_id.clone();
        self.state = Some(state);
        Ok(())
    }

    pub fn authorizes(&self, peer: PeerId, certificate: Option<&MembershipCertificate>) -> bool {
        let (Some(state), Some(certificate)) = (&self.state, certificate) else {
            return false;
        };
        verify_certificate(
            certificate,
            &state.network_id,
            peer,
            &state.root_peer_id,
            &state.root_public_key,
        )
        .is_ok()
    }

    fn ensure_root(&mut self, identity: &identity::Keypair, bootstrap: Vec<String>) -> Result<()> {
        if self.state.is_some() {
            return Ok(());
        }
        let now = Utc::now().timestamp();
        let certificate = sign_certificate(identity, &self.network_id, self.local_peer, now)?;
        let state = MembershipState {
            version: 1,
            network_id: self.network_id.clone(),
            root_peer_id: self.local_peer.to_string(),
            root_public_key: encode_public_key(&identity.public())?,
            certificate,
            bootstrap,
        };
        write_private_json(&self.state_dir.join("membership.json"), &state)?;
        self.state = Some(state);
        Ok(())
    }

    fn read_invites(&self) -> Result<InviteDatabase> {
        Ok(read_optional(&self.state_dir.join("invites.json"))?.unwrap_or_default())
    }

    fn write_invites(&self, database: &InviteDatabase) -> Result<()> {
        write_private_json(&self.state_dir.join("invites.json"), database)
    }
}

pub fn verify_certificate(
    certificate: &MembershipCertificate,
    network_id: &str,
    peer: PeerId,
    root_peer_id: &str,
    root_public_key: &str,
) -> Result<()> {
    if certificate.version != 1
        || certificate.network_id != network_id
        || certificate.peer_id != peer.to_string()
        || certificate.issuer_peer_id != root_peer_id
        || certificate.issued_at > Utc::now().timestamp() + 30
        || certificate.expires_at <= Utc::now().timestamp()
    {
        bail!("membership certificate does not authorize this peer")
    }
    let public = decode_public_key(root_public_key)?;
    if public.to_peer_id().to_string() != root_peer_id {
        bail!("membership root key does not match root peer ID")
    }
    let signature = URL_SAFE_NO_PAD
        .decode(&certificate.signature)
        .context("invalid membership signature encoding")?;
    if !public.verify(&certificate_payload(certificate)?, &signature) {
        bail!("membership certificate signature is invalid")
    }
    Ok(())
}

fn sign_certificate(
    identity: &identity::Keypair,
    network_id: &str,
    peer: PeerId,
    now: i64,
) -> Result<MembershipCertificate> {
    let mut certificate = MembershipCertificate {
        version: 1,
        network_id: network_id.to_owned(),
        peer_id: peer.to_string(),
        issuer_peer_id: identity.public().to_peer_id().to_string(),
        issued_at: now,
        expires_at: now + MEMBER_LIFETIME_SECS,
        signature: String::new(),
    };
    certificate.signature =
        URL_SAFE_NO_PAD.encode(identity.sign(&certificate_payload(&certificate)?)?);
    Ok(certificate)
}

fn ticket_payload(ticket: &JoinTicket) -> Result<Vec<u8>> {
    #[derive(Serialize)]
    struct Payload<'a> {
        domain: &'static str,
        version: u8,
        network_id: &'a str,
        issuer_peer_id: &'a str,
        issuer_public_key: &'a str,
        bootstrap: &'a [String],
        token: &'a str,
        expires_at: i64,
    }
    Ok(serde_json::to_vec(&Payload {
        domain: "agent-mesh-join-ticket-v1",
        version: ticket.version,
        network_id: &ticket.network_id,
        issuer_peer_id: &ticket.issuer_peer_id,
        issuer_public_key: &ticket.issuer_public_key,
        bootstrap: &ticket.bootstrap,
        token: &ticket.token,
        expires_at: ticket.expires_at,
    })?)
}

fn certificate_payload(certificate: &MembershipCertificate) -> Result<Vec<u8>> {
    #[derive(Serialize)]
    struct Payload<'a> {
        domain: &'static str,
        version: u8,
        network_id: &'a str,
        peer_id: &'a str,
        issuer_peer_id: &'a str,
        issued_at: i64,
        expires_at: i64,
    }
    Ok(serde_json::to_vec(&Payload {
        domain: "agent-mesh-membership-v1",
        version: certificate.version,
        network_id: &certificate.network_id,
        peer_id: &certificate.peer_id,
        issuer_peer_id: &certificate.issuer_peer_id,
        issued_at: certificate.issued_at,
        expires_at: certificate.expires_at,
    })?)
}

fn encode_public_key(public: &identity::PublicKey) -> Result<String> {
    Ok(URL_SAFE_NO_PAD.encode(public.encode_protobuf()))
}

fn decode_public_key(encoded: &str) -> Result<identity::PublicKey> {
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .context("invalid membership root key encoding")?;
    identity::PublicKey::try_decode_protobuf(&bytes).context("invalid membership root public key")
}

fn token_hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

fn address_peer(address: &Multiaddr) -> Option<PeerId> {
    match address.iter().last() {
        Some(libp2p::multiaddr::Protocol::P2p(peer)) => Some(peer),
        _ => None,
    }
}

fn read_optional<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Option<T>> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(path).with_context(|| format!("failed to read {}", path.display()))?;
    Ok(Some(serde_json::from_slice(&bytes).with_context(|| {
        format!("failed to parse {}", path.display())
    })?))
}

fn write_private_json(path: &Path, value: &impl Serialize) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, serde_json::to_vec_pretty(value)?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))?;
    }
    fs::rename(temporary, path)?;
    Ok(())
}

fn validate_state(state: &MembershipState, local_peer: PeerId) -> Result<()> {
    if state.version != 1 {
        bail!("unsupported membership state version {}", state.version)
    }
    verify_certificate(
        &state.certificate,
        &state.network_id,
        local_peer,
        &state.root_peer_id,
        &state.root_public_key,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invitation_is_signed_single_use_and_issues_a_valid_certificate() {
        let temp = tempfile::tempdir().unwrap();
        let root_key = identity::Keypair::generate_ed25519();
        let root_peer = root_key.public().to_peer_id();
        let member_key = identity::Keypair::generate_ed25519();
        let member_peer = member_key.public().to_peer_id();
        let address = format!("/ip4/10.0.0.1/tcp/41001/p2p/{root_peer}");
        let mut root =
            MembershipManager::open(temp.path().join("root"), "team", root_peer).unwrap();
        let ticket = root.create_invite(&root_key, vec![address], 900).unwrap();
        let decoded = JoinTicket::decode(&ticket.encode().unwrap()).unwrap();
        let certificate = root.admit(&root_key, &decoded.token, member_peer).unwrap();
        assert!(root.admit(&root_key, &decoded.token, member_peer).is_err());

        let mut member =
            MembershipManager::open(temp.path().join("member"), "team", member_peer).unwrap();
        member.accept(&decoded, certificate.clone()).unwrap();
        assert!(member.authorizes(member_peer, Some(&certificate)));
        assert_eq!(member.state().unwrap().root_peer_id, root_peer.to_string());
    }

    #[test]
    fn tampered_invitation_is_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let root_key = identity::Keypair::generate_ed25519();
        let root_peer = root_key.public().to_peer_id();
        let mut root = MembershipManager::open(temp.path(), "team", root_peer).unwrap();
        let address = format!("/ip4/127.0.0.1/tcp/1/p2p/{root_peer}");
        let mut ticket = root.create_invite(&root_key, vec![address], 900).unwrap();
        ticket.network_id = "evil".into();
        assert!(ticket.verify().is_err());
    }
}
