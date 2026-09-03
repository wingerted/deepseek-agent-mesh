use std::{fs, path::Path};

use anyhow::{Context, Result};
use base64::{Engine, engine::general_purpose::STANDARD};
use libp2p::identity::Keypair;

pub fn load_or_create(path: &Path) -> Result<Keypair> {
    if path.exists() {
        let encoded = fs::read_to_string(path)
            .with_context(|| format!("failed to read identity {}", path.display()))?;
        let bytes = STANDARD.decode(encoded.trim())?;
        return Keypair::from_protobuf_encoding(&bytes).context("invalid identity key");
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let key = Keypair::generate_ed25519();
    let bytes = key.to_protobuf_encoding()?;
    fs::write(path, STANDARD.encode(bytes))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(key)
}
