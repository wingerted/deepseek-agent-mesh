use std::{net::SocketAddr, path::Path};

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpStream,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControlFile {
    pub version: u8,
    pub address: SocketAddr,
    pub token: String,
    pub peer_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcRequest {
    pub token: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl RpcResponse {
    pub fn success(result: Value) -> Self {
        Self {
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    pub fn failure(error: impl ToString) -> Self {
        Self {
            ok: false,
            result: None,
            error: Some(error.to_string()),
        }
    }
}

pub async fn call(state_dir: &Path, method: &str, params: Value) -> Result<Value> {
    let control_path = state_dir.join("control.json");
    let control: ControlFile =
        serde_json::from_slice(&tokio::fs::read(&control_path).await.with_context(|| {
            format!(
                "daemon is not running: {} is unavailable",
                control_path.display()
            )
        })?)?;
    let mut stream = TcpStream::connect(control.address)
        .await
        .with_context(|| format!("cannot connect to mesh daemon at {}", control.address))?;
    let request = RpcRequest {
        token: control.token,
        method: method.to_owned(),
        params,
    };
    let mut bytes = serde_json::to_vec(&request)?;
    bytes.push(b'\n');
    stream.write_all(&bytes).await?;
    let mut response = String::new();
    BufReader::new(stream).read_line(&mut response).await?;
    if response.is_empty() {
        bail!("mesh daemon closed the control connection")
    }
    let response: RpcResponse = serde_json::from_str(&response)?;
    if response.ok {
        Ok(response.result.unwrap_or(Value::Null))
    } else {
        Err(anyhow!(
            response.error.unwrap_or_else(|| "mesh daemon error".into())
        ))
    }
}
