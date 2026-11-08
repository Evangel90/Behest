//! Storage layout before the configurable ETH gas limit (contract v0.1).
//! Plans stored in that layout are converted the first time they are touched;
//! every ETH transaction signed back then used a 21 000 gas limit.

use near_sdk::json_types::U128;
use near_sdk::store::{IterableSet, LookupMap};
use near_sdk::{near, AccountId};

use crate::types::{Asset, EthSignature, EthTxParams, Plan, PlanInput, Proposal, SignedVersion, Transfer, TransferState};

pub const V1_GAS_LIMIT: u64 = 21_000;

#[near(serializers = [borsh])]
pub struct ContractV1 {
    pub admin: AccountId,
    pub mpc_contract: AccountId,
    pub eth_chain_id: u64,
    pub eth_max_fee_cap: U128,
    pub eth_initial_max_fee: U128,
    pub eth_priority_fee: U128,
    pub paused: bool,
    pub executors: IterableSet<AccountId>,
    pub open_releases: IterableSet<AccountId>,
    pub plans: LookupMap<AccountId, PlanV1>,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct PlanV1 {
    pub owner: AccountId,
    pub version: u32,
    pub policy: PlanInput,
    pub last_check_in_ms: u64,
    pub escrow: U128,
    pub eth_next_nonce: u64,
    pub proposal: Option<ProposalV1>,
    pub proposals_opened: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct ProposalV1 {
    pub id: u64,
    pub plan_version: u32,
    pub proposer: AccountId,
    pub created_at_ms: u64,
    pub approvals: Vec<AccountId>,
    pub rejections: Vec<AccountId>,
    pub approved_at_ms: Option<u64>,
    pub waiting_ends_at_ms: Option<u64>,
    pub near_snapshot: U128,
    pub eth_snapshot: U128,
    pub eth_fee_reserve: U128,
    pub transfers: Vec<TransferV1>,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct TransferV1 {
    pub heir: AccountId,
    pub asset: Asset,
    pub destination: String,
    pub amount: U128,
    pub state: TransferState,
    pub eth_tx: Option<EthTxParamsV1>,
    pub signature: Option<EthSignature>,
    pub signed_versions: Vec<SignedVersionV1>,
    pub attempts: u32,
    pub tx_hash: Option<String>,
    pub failure: Option<String>,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct EthTxParamsV1 {
    pub chain_id: u64,
    pub nonce: u64,
    pub max_fee_per_gas: U128,
    pub max_priority_fee_per_gas: U128,
    pub payload_hash: String,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct SignedVersionV1 {
    pub eth_tx: EthTxParamsV1,
    pub signature: EthSignature,
}

impl From<EthTxParamsV1> for EthTxParams {
    fn from(p: EthTxParamsV1) -> Self {
        EthTxParams {
            chain_id: p.chain_id,
            nonce: p.nonce,
            max_fee_per_gas: p.max_fee_per_gas,
            max_priority_fee_per_gas: p.max_priority_fee_per_gas,
            payload_hash: p.payload_hash,
            gas_limit: V1_GAS_LIMIT,
        }
    }
}

impl From<PlanV1> for Plan {
    fn from(p: PlanV1) -> Self {
        Plan {
            owner: p.owner,
            version: p.version,
            policy: p.policy,
            last_check_in_ms: p.last_check_in_ms,
            escrow: p.escrow,
            eth_next_nonce: p.eth_next_nonce,
            proposals_opened: p.proposals_opened,
            proposal: p.proposal.map(|q| Proposal {
                id: q.id,
                plan_version: q.plan_version,
                proposer: q.proposer,
                created_at_ms: q.created_at_ms,
                approvals: q.approvals,
                rejections: q.rejections,
                approved_at_ms: q.approved_at_ms,
                waiting_ends_at_ms: q.waiting_ends_at_ms,
                near_snapshot: q.near_snapshot,
                eth_snapshot: q.eth_snapshot,
                eth_fee_reserve: q.eth_fee_reserve,
                eth_gas_limit: V1_GAS_LIMIT,
                transfers: q
                    .transfers
                    .into_iter()
                    .map(|t| Transfer {
                        heir: t.heir,
                        asset: t.asset,
                        destination: t.destination,
                        amount: t.amount,
                        state: t.state,
                        eth_tx: t.eth_tx.map(Into::into),
                        signature: t.signature,
                        signed_versions: t
                            .signed_versions
                            .into_iter()
                            .map(|v| SignedVersion { eth_tx: v.eth_tx.into(), signature: v.signature })
                            .collect(),
                        attempts: t.attempts,
                        tx_hash: t.tx_hash,
                        failure: t.failure,
                    })
                    .collect(),
            }),
        }
    }
}
