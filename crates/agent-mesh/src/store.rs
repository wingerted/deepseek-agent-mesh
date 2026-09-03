use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail};
use sha2::{Digest, Sha256};

use crate::model::{DEFAULT_CHUNK_SIZE, ObjectSummary};

#[derive(Debug, Clone)]
pub struct ObjectStore {
    root: PathBuf,
}

impl ObjectStore {
    pub fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        fs::create_dir_all(root.join("objects"))?;
        Ok(Self { root })
    }

    pub fn import(&self, source: &Path) -> Result<ObjectSummary> {
        let mut input =
            File::open(source).with_context(|| format!("failed to open {}", source.display()))?;
        let size = input.metadata()?.len();
        let mut digest = Sha256::new();
        let mut buffer = vec![0_u8; 1024 * 1024];
        loop {
            let read = input.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            digest.update(&buffer[..read]);
        }
        let object_id = hex::encode(digest.finalize());
        let target = self.object_path(&object_id)?;
        if !target.exists() {
            let temporary = self.root.join("objects").join(format!(".{object_id}.tmp"));
            input.seek(SeekFrom::Start(0))?;
            let mut output = File::create(&temporary)?;
            std::io::copy(&mut input, &mut output)?;
            output.sync_all()?;
            fs::rename(temporary, &target)?;
        }
        Ok(ObjectSummary::new(object_id, size, DEFAULT_CHUNK_SIZE))
    }

    pub fn inventory(&self) -> Result<Vec<ObjectSummary>> {
        let mut objects = Vec::new();
        for entry in fs::read_dir(self.root.join("objects"))? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if valid_object_id(&name) {
                objects.push(ObjectSummary::new(
                    name,
                    entry.metadata()?.len(),
                    DEFAULT_CHUNK_SIZE,
                ));
            }
        }
        objects.sort_by(|a, b| a.object_id.cmp(&b.object_id));
        Ok(objects)
    }

    pub fn metadata(&self, object_id: &str) -> Result<ObjectSummary> {
        let path = self.object_path(object_id)?;
        let size = fs::metadata(path)?.len();
        Ok(ObjectSummary::new(
            object_id.to_owned(),
            size,
            DEFAULT_CHUNK_SIZE,
        ))
    }

    pub fn read_chunk(&self, object_id: &str, index: u64) -> Result<Vec<u8>> {
        let metadata = self.metadata(object_id)?;
        if index >= metadata.chunk_count {
            bail!("chunk index out of range")
        }
        let mut file = File::open(self.object_path(object_id)?)?;
        file.seek(SeekFrom::Start(index * metadata.chunk_size))?;
        let remaining = metadata.size.saturating_sub(index * metadata.chunk_size);
        let length = remaining.min(metadata.chunk_size) as usize;
        let mut data = vec![0_u8; length];
        file.read_exact(&mut data)?;
        Ok(data)
    }

    pub fn create_download(&self, object_id: &str) -> Result<DownloadWriter> {
        let target = self.object_path(object_id)?;
        let partial = self
            .root
            .join("objects")
            .join(format!(".{object_id}.download"));
        Ok(DownloadWriter {
            expected_id: object_id.to_owned(),
            target,
            partial,
            file: None,
            digest: Sha256::new(),
            written: 0,
        })
    }

    pub fn export(&self, object_id: &str, output: &Path) -> Result<()> {
        let source = self.object_path(object_id)?;
        if source == output {
            return Ok(());
        }
        if let Some(parent) = output.parent()
            && !parent.as_os_str().is_empty()
        {
            fs::create_dir_all(parent)?;
        }
        fs::copy(&source, output).with_context(|| {
            format!(
                "failed to export object {object_id} to {}",
                output.display()
            )
        })?;
        Ok(())
    }

    pub fn schedule_delete(&self, object_id: &str) -> Result<PathBuf> {
        let source = self.object_path(object_id)?;
        if !source.exists() {
            bail!("object not found")
        }
        let trash = self.root.join("delete-pending");
        fs::create_dir_all(&trash)?;
        let target = trash.join(object_id);
        fs::rename(source, &target)?;
        Ok(target)
    }

    fn object_path(&self, object_id: &str) -> Result<PathBuf> {
        if !valid_object_id(object_id) {
            bail!("object id must be a lowercase SHA-256 hex digest")
        }
        Ok(self.root.join("objects").join(object_id))
    }
}

pub struct DownloadWriter {
    expected_id: String,
    target: PathBuf,
    partial: PathBuf,
    file: Option<File>,
    digest: Sha256,
    written: u64,
}

impl DownloadWriter {
    pub fn append(&mut self, data: &[u8]) -> Result<()> {
        if self.file.is_none() {
            self.file = Some(File::create(&self.partial)?);
        }
        self.file.as_mut().unwrap().write_all(data)?;
        self.digest.update(data);
        self.written += data.len() as u64;
        Ok(())
    }

    pub fn finish(mut self) -> Result<PathBuf> {
        if self.file.is_none() {
            self.file = Some(File::create(&self.partial)?);
        }
        self.file.as_mut().unwrap().sync_all()?;
        let actual = hex::encode(self.digest.finalize());
        if actual != self.expected_id {
            let _ = fs::remove_file(&self.partial);
            bail!(
                "object checksum mismatch: expected {}, got {actual}",
                self.expected_id
            )
        }
        fs::rename(&self.partial, &self.target)?;
        Ok(self.target)
    }
}

fn valid_object_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn import_and_read_round_trip() {
        let directory = tempfile::tempdir().unwrap();
        let input = directory.path().join("input");
        fs::write(&input, b"hello mesh").unwrap();
        let store = ObjectStore::open(directory.path().join("store")).unwrap();
        let object = store.import(&input).unwrap();
        assert_eq!(
            store.read_chunk(&object.object_id, 0).unwrap(),
            b"hello mesh"
        );
        assert_eq!(store.inventory().unwrap(), vec![object]);
    }

    #[test]
    fn scheduled_delete_is_recoverable() {
        let directory = tempfile::tempdir().unwrap();
        let input = directory.path().join("input");
        fs::write(&input, b"recover me").unwrap();
        let store = ObjectStore::open(directory.path().join("store")).unwrap();
        let object = store.import(&input).unwrap();
        let pending = store.schedule_delete(&object.object_id).unwrap();
        assert!(pending.exists());
        assert!(store.inventory().unwrap().is_empty());
        assert_eq!(fs::read(pending).unwrap(), b"recover me");
    }
}
