use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    envelope::Envelope,
    membership::MembershipCertificate,
    model::{AgentAdvertisement, ObjectSummary},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum MeshRequest {
    GetAdvertisement,
    GetInventory,
    GetChunk {
        object_id: String,
        index: u64,
    },
    TransferReceipt {
        object_id: String,
        received_sha256: String,
        request_source_delete: bool,
    },
    DeliverEnvelope {
        envelope: Box<Envelope>,
        #[serde(default)]
        membership: Option<MembershipCertificate>,
    },
    JoinNetwork {
        token: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum MeshResponse {
    Advertisement(Box<AgentAdvertisement>),
    Inventory(Vec<ObjectSummary>),
    Chunk {
        object_id: String,
        index: u64,
        total_chunks: u64,
        data_sha256: String,
        data: Vec<u8>,
    },
    ReceiptAccepted {
        delete_pending: bool,
    },
    EnvelopeAccepted {
        id: uuid::Uuid,
    },
    NetworkJoined {
        certificate: MembershipCertificate,
    },
    Error {
        message: String,
    },
}

pub fn chunk_response(object: &ObjectSummary, index: u64, data: Vec<u8>) -> MeshResponse {
    let data_sha256 = hex::encode(Sha256::digest(&data));
    MeshResponse::Chunk {
        object_id: object.object_id.clone(),
        index,
        total_chunks: object.chunk_count,
        data_sha256,
        data,
    }
}
