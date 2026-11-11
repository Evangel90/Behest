//! Unit tests for the MVP lifecycle. Timers use production bounds unless the
//! crate is built with `demo-timers`, so durations here are production-valid.

use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, NearToken};

const DAY: u64 = 86_400_000;
const NEAR: u128 = 10u128.pow(24);
const GWEI: u128 = 1_000_000_000;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

struct Env {
    c: Contract,
    t: u64,
}

impl Env {
    fn new() -> Self {
        testing_env!(VMContextBuilder::new().current_account_id(acc("behest.testnet")).build());
        Env { c: Contract::new(acc("admin.testnet"), acc("v1.signer-prod.testnet"), 11155111, U128(50 * GWEI), U128(20 * GWEI), U128(2 * GWEI), Some(21_000)), t: 1_000 * DAY }
    }

    fn as_(&mut self, who: &str, deposit: u128) -> &mut Contract {
        let ctx = VMContextBuilder::new()
            .current_account_id(acc("behest.testnet"))
            .predecessor_account_id(acc(who))
            .signer_account_id(acc(who))
            .block_timestamp(self.t * 1_000_000)
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .account_balance(NearToken::from_near(1_000))
            .build();
        testing_env!(ctx);
        &mut self.c
    }

    fn advance(&mut self, ms: u64) {
        self.t += ms;
    }

    fn status(&mut self) -> PlanStatus {
        self.as_("anyone.testnet", 0).get_plan(acc("owner.testnet")).unwrap().status
    }

    fn plan(&mut self) -> Plan {
        self.as_("anyone.testnet", 0).get_plan(acc("owner.testnet")).unwrap().plan
    }
}

fn plan_input() -> PlanInput {
    PlanInput {
        check_in_interval_ms: 90 * DAY,
        grace_ms: 7 * DAY,
        waiting_period_ms: 30 * DAY,
        guardians: vec![acc("g1.testnet"), acc("g2.testnet"), acc("g3.testnet")],
        quorum: 2,
        heirs: vec![
            HeirInput {
                account_id: acc("amara.testnet"),
                share_bps: 6000,
                near_destination: Some(acc("amara.testnet")),
                eth_destination: Some("0x71C7656EC7ab88b098defB751B7401B5f6d8976F".into()),
            },
            HeirInput { account_id: acc("tobi.testnet"), share_bps: 4000, near_destination: Some(acc("tobi-wallet.testnet")), eth_destination: None },
        ],
    }
}

/// Plan created and funded with 10 NEAR, then left overdue.
fn funded_overdue() -> Env {
    let mut e = Env::new();
    e.as_("owner.testnet", NEAR).set_plan(plan_input());
    e.as_("owner.testnet", 10 * NEAR).deposit(acc("owner.testnet"));
    e.advance(97 * DAY);
    e
}

fn approved() -> Env {
    let mut e = funded_overdue();
    let id = e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), Some(U128(NEAR)), None, None);
    e.as_("g2.testnet", 0).approve_release(acc("owner.testnet"), id);
    e
}

// --------------------------------------------------------------- happy path

#[test]
fn lifecycle_active_to_eligible() {
    let mut e = Env::new();
    e.as_("owner.testnet", NEAR).set_plan(plan_input());
    assert_eq!(e.status(), PlanStatus::Active);
    e.as_("owner.testnet", 10 * NEAR).deposit(acc("owner.testnet"));

    e.advance(97 * DAY - 1);
    assert_eq!(e.status(), PlanStatus::Active);
    e.advance(1);
    assert_eq!(e.status(), PlanStatus::Overdue);

    let id = e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), Some(U128(NEAR)), None, None);
    assert_eq!(e.status(), PlanStatus::Proposed);
    e.as_("g3.testnet", 0).approve_release(acc("owner.testnet"), id);
    assert_eq!(e.status(), PlanStatus::Waiting);

    e.advance(30 * DAY);
    assert_eq!(e.status(), PlanStatus::Eligible);
}

#[test]
fn snapshot_splits_by_share_and_reserves_eth_fees() {
    let mut e = approved();
    let p = e.plan().proposal.unwrap();
    let near: Vec<_> = p.transfers.iter().filter(|t| t.asset == Asset::Near).map(|t| (t.heir.to_string(), t.amount.0)).collect();
    assert_eq!(near, vec![("amara.testnet".into(), 6 * NEAR), ("tobi.testnet".into(), 4 * NEAR)]);

    // one ETH heir: reserve = 21000 * 50 gwei; amara gets 60% of the rest
    let reserve = 21_000 * 50 * GWEI;
    assert_eq!(p.eth_fee_reserve.0, reserve);
    let eth: Vec<_> = p.transfers.iter().filter(|t| t.asset == Asset::Eth).collect();
    assert_eq!(eth.len(), 1);
    assert_eq!(eth[0].amount.0, policy::share_of(NEAR - reserve, 6000));
    assert_eq!(eth[0].destination, "0x71c7656ec7ab88b098defb751b7401b5f6d8976f");
    assert_eq!(e.plan().escrow.0, 0);
}

#[test]
fn heir_claims_near_after_waiting() {
    let mut e = approved();
    e.advance(30 * DAY);
    let _ = e.as_("amara.testnet", 0).claim(acc("owner.testnet"));
    let p = e.plan().proposal.unwrap();
    let t = p.transfers.iter().find(|t| t.heir == acc("amara.testnet") && t.asset == Asset::Near).unwrap();
    assert_eq!(t.state, TransferState::Sending);
    assert_eq!(e.status(), PlanStatus::Executing);
}

#[test]
fn share_rounding_never_exceeds_total() {
    for total in [0u128, 1, 9_999, 10_001, 123_456_789, u128::MAX / 3] {
        let a = policy::share_of(total, 3333);
        let b = policy::share_of(total, 3333);
        let c = policy::share_of(total, 3334);
        assert!(a + b + c <= total);
        assert!(total - (a + b + c) < 3);
    }
}

// ------------------------------------------------------- owner protection

#[test]
fn owner_check_in_cancels_waiting_proposal_and_restores_escrow() {
    let mut e = approved();
    e.advance(30 * DAY - 1);
    e.as_("owner.testnet", 0).check_in(None);
    assert_eq!(e.status(), PlanStatus::Active);
    assert_eq!(e.plan().escrow.0, 10 * NEAR);
}

#[test]
fn owner_cancels_proposed_release() {
    let mut e = funded_overdue();
    e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), None, None, None);
    e.as_("owner.testnet", 0).cancel_release();
    assert_eq!(e.status(), PlanStatus::Active);
}

#[test]
#[should_panic(expected = "E_CANCEL_WINDOW_CLOSED")]
fn owner_cannot_cancel_at_cutoff() {
    let mut e = approved();
    e.advance(30 * DAY);
    e.as_("owner.testnet", 0).cancel_release();
}

#[test]
#[should_panic(expected = "E_NOT_ELIGIBLE")]
fn heir_cannot_claim_before_cutoff() {
    let mut e = approved();
    e.advance(30 * DAY - 1);
    let _ = e.as_("amara.testnet", 0).claim(acc("owner.testnet"));
}

#[test]
#[should_panic(expected = "E_PROPOSAL_OPEN")]
fn plan_frozen_while_proposal_open() {
    let mut e = approved();
    e.as_("owner.testnet", NEAR).set_plan(plan_input());
}

#[test]
#[should_panic(expected = "E_PROPOSAL_OPEN")]
fn withdraw_frozen_while_proposal_open() {
    let mut e = approved();
    let _ = e.as_("owner.testnet", 0).withdraw(U128(1));
}

// --------------------------------------------------------- authorization

#[test]
#[should_panic(expected = "E_NOT_OVERDUE")]
fn cannot_propose_while_owner_current() {
    let mut e = Env::new();
    e.as_("owner.testnet", NEAR).set_plan(plan_input());
    e.as_("owner.testnet", NEAR).deposit(acc("owner.testnet"));
    e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), None, None, None);
}

#[test]
#[should_panic(expected = "E_NOT_GUARDIAN")]
fn non_guardian_cannot_propose() {
    let mut e = funded_overdue();
    e.as_("amara.testnet", 0).propose_release(acc("owner.testnet"), None, None, None);
}

#[test]
#[should_panic(expected = "E_ALREADY_VOTED")]
fn guardian_cannot_vote_twice() {
    let mut e = funded_overdue();
    let id = e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), None, None, None);
    e.as_("g1.testnet", 0).approve_release(acc("owner.testnet"), id);
}

#[test]
fn insufficient_quorum_stays_proposed() {
    let mut e = funded_overdue();
    e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), None, None, None);
    e.advance(365 * DAY);
    assert_eq!(e.status(), PlanStatus::Proposed);
}

#[test]
fn rejections_that_make_quorum_impossible_kill_the_proposal() {
    let mut e = funded_overdue();
    let id = e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), None, None, None);
    e.as_("g2.testnet", 0).reject_release(acc("owner.testnet"), id);
    assert_eq!(e.status(), PlanStatus::Proposed);
    e.as_("g3.testnet", 0).reject_release(acc("owner.testnet"), id);
    assert_eq!(e.status(), PlanStatus::Overdue);
    assert_eq!(e.plan().escrow.0, 10 * NEAR);
}

#[test]
#[should_panic(expected = "E_NOT_HEIR")]
fn stranger_cannot_claim() {
    let mut e = approved();
    e.advance(30 * DAY);
    let _ = e.as_("g1.testnet", 0).claim(acc("owner.testnet"));
}

#[test]
fn duplicate_claim_does_not_restart_transfer() {
    let mut e = approved();
    e.advance(30 * DAY);
    let _ = e.as_("amara.testnet", 0).claim(acc("owner.testnet"));
    let before = e.plan().proposal.unwrap().transfers;
    let _ = e.as_("amara.testnet", 0).claim(acc("owner.testnet"));
    assert_eq!(e.plan().proposal.unwrap().transfers, before);
}

#[test]
fn heir_claim_only_touches_own_transfers() {
    let mut e = approved();
    e.advance(30 * DAY);
    let _ = e.as_("tobi.testnet", 0).claim(acc("owner.testnet"));
    for t in e.plan().proposal.unwrap().transfers {
        let expected = if t.heir == acc("tobi.testnet") && t.asset == Asset::Near { TransferState::Sending } else { TransferState::Pending };
        assert_eq!(t.state, expected);
    }
}

#[test]
#[should_panic(expected = "E_UNAUTHORIZED")]
fn only_admin_can_pause() {
    let mut e = Env::new();
    e.as_("owner.testnet", 0).set_paused(true);
}

#[test]
#[should_panic(expected = "E_PAUSED")]
fn pause_blocks_claims() {
    let mut e = approved();
    e.advance(30 * DAY);
    e.as_("admin.testnet", 0).set_paused(true);
    let _ = e.as_("amara.testnet", 0).claim(acc("owner.testnet"));
}

// ------------------------------------------------------------ fee reserve

#[test]
#[should_panic(expected = "E_INSUFFICIENT_FEE_RESERVE")]
fn eth_balance_below_fee_reserve_is_rejected() {
    let mut e = funded_overdue();
    e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), Some(U128(21_000 * 50 * GWEI)), None, None);
}

// -------------------------------------------------------------- validation

fn expect_invalid(mutate: impl FnOnce(&mut PlanInput)) {
    let mut p = plan_input();
    mutate(&mut p);
    let mut e = Env::new();
    e.as_("owner.testnet", NEAR).set_plan(p);
}

#[test]
#[should_panic(expected = "E_INVALID_SHARES")]
fn shares_must_sum_to_10000() {
    expect_invalid(|p| p.heirs[0].share_bps = 5000);
}

#[test]
#[should_panic(expected = "E_INVALID_QUORUM")]
fn quorum_cannot_exceed_guardians() {
    expect_invalid(|p| p.quorum = 4);
}

#[test]
#[should_panic(expected = "E_CONFLICTING_ROLE")]
fn guardian_cannot_be_heir() {
    expect_invalid(|p| p.guardians[0] = acc("amara.testnet"));
}

#[test]
#[should_panic(expected = "E_INVALID_ETH_ADDRESS")]
fn eth_address_validated() {
    expect_invalid(|p| p.heirs[0].eth_destination = Some("0x1234".into()));
}

#[test]
#[should_panic(expected = "E_NO_DESTINATION")]
fn heir_needs_a_destination() {
    expect_invalid(|p| {
        p.heirs[1].near_destination = None;
    });
}

#[cfg(not(feature = "demo-timers"))]
#[test]
#[should_panic(expected = "E_DURATION_OUT_OF_BOUNDS")]
fn production_build_rejects_demo_timers() {
    expect_invalid(|p| p.check_in_interval_ms = 60_000);
}

#[test]
#[should_panic(expected = "E_INSUFFICIENT_DEPOSIT")]
fn plan_creation_requires_storage_deposit() {
    let mut e = Env::new();
    e.as_("owner.testnet", 0).set_plan(plan_input());
}

// ================================================================== ETH path

use near_sdk::PromiseResult;

const AMARA_ETH: &str = "0x71c7656ec7ab88b098defb751b7401b5f6d8976f";

impl Env {
    /// Runs a private callback as the contract itself with the given promise results.
    fn callback(&mut self, results: Vec<PromiseResult>) -> &mut Contract {
        let ctx = VMContextBuilder::new()
            .current_account_id(acc("behest.testnet"))
            .predecessor_account_id(acc("behest.testnet"))
            .block_timestamp(self.t * 1_000_000)
            .build();
        testing_env!(ctx, near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(), Default::default(), results);
        &mut self.c
    }

    fn eth_index(&mut self) -> u32 {
        self.plan().proposal.unwrap().transfers.iter().position(|t| t.asset == Asset::Eth).unwrap() as u32
    }

    fn eth_transfer(&mut self) -> Transfer {
        let i = self.eth_index() as usize;
        self.plan().proposal.unwrap().transfers[i].clone()
    }
}

fn mpc_ok(big_r: &str, s: &str, v: u8) -> PromiseResult {
    let body = format!(r#"{{"scheme":"Secp256k1","big_r":{{"affine_point":"{big_r}"}},"s":{{"scalar":"{s}"}},"recovery_id":{v}}}"#);
    PromiseResult::Successful(body.into_bytes())
}

const BIG_R: &str = "0200a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f";
const S: &str = "1122334455667788990011223344556677889900112233445566778899001122";

/// Eligible plan where amara has claimed (ETH transfer now `Signing`).
fn eth_claimed() -> Env {
    let mut e = approved();
    e.advance(30 * DAY);
    let _ = e.as_("amara.testnet", 0).claim(acc("owner.testnet"));
    e
}

fn eth_signed() -> Env {
    let mut e = eth_claimed();
    let i = e.eth_index();
    e.callback(vec![mpc_ok(BIG_R, S, 1)]).on_eth_signed(acc("owner.testnet"), i, 1);
    e
}

#[test]
fn eip1559_encoding_matches_viem() {
    // Reference values from viem 2.57.16 serializeTransaction / keccak256.
    let to = eth::parse_address(AMARA_ETH).unwrap();
    let tx = eth::EthTransfer {
        chain_id: 11155111,
        nonce: 0,
        max_priority_fee_per_gas: 2 * GWEI,
        max_fee_per_gas: 20 * GWEI,
        gas_limit: 21_000,
        to: &to,
        value: 599_999_979_000_000_000,
        data: &[],
    };
    testing_env!(VMContextBuilder::new().build());
    assert_eq!(
        eth::hex_encode(&tx.unsigned()),
        "02f383aa36a78084773594008504a817c8008252089471c7656ec7ab88b098defb751b7401b5f6d8976f880853a0cd4d896e0080c0"
    );
    assert_eq!(eth::hex_encode(&tx.signing_hash()), "dbf48e8026d50d4fb064cc7875c59cdee78bd9a31b0f3ef9b56baf7e61dd7b35");
    let sig = eth::RsvSignature {
        r: eth::hex_decode(&BIG_R[2..]).unwrap().try_into().unwrap(),
        s: eth::hex_decode(S).unwrap().try_into().unwrap(),
        y_parity: 1,
    };
    // r has a leading zero byte, which must be stripped (31-byte r).
    assert_eq!(
        eth::hex_encode(&tx.signed(&sig)),
        "02f87583aa36a78084773594008504a817c8008252089471c7656ec7ab88b098defb751b7401b5f6d8976f880853a0cd4d896e0080c0019fa1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8fa01122334455667788990011223344556677889900112233445566778899001122"
    );
}

#[test]
fn fee_bump_is_at_least_12_5_percent_and_capped() {
    assert_eq!(eth::bump(8, 100), 9);
    assert_eq!(eth::bump(20 * GWEI, 50 * GWEI), 22_500_000_000);
    assert_eq!(eth::bump(48 * GWEI, 50 * GWEI), 50 * GWEI);
    assert_eq!(eth::bump(50 * GWEI, 50 * GWEI), 50 * GWEI);
    assert_eq!(eth::bump(0, 10), 1);
}

#[test]
fn eth_claim_assigns_nonce_and_requests_exact_payload() {
    let mut e = approved();
    e.advance(30 * DAY);
    let _ = e.as_("amara.testnet", 0).claim(acc("owner.testnet"));
    // Read receipts before the next call resets the mocked chain.
    let receipts = near_sdk::test_utils::get_created_receipts();
    let tr = e.eth_transfer();
    assert_eq!(tr.state, TransferState::Signing);
    assert_eq!(tr.attempts, 1);
    let p = tr.eth_tx.clone().unwrap();
    assert_eq!((p.chain_id, p.nonce, p.max_fee_per_gas.0, p.max_priority_fee_per_gas.0), (11155111, 0, 20 * GWEI, 2 * GWEI));
    assert_eq!(e.plan().eth_next_nonce, 1);

    // The hash sent to the MPC is exactly the snapshot transfer.
    let to = eth::parse_address(&tr.destination).unwrap();
    let expected = eth::EthTransfer { chain_id: 11155111, nonce: 0, max_priority_fee_per_gas: 2 * GWEI, max_fee_per_gas: 20 * GWEI, gas_limit: 21_000, to: &to, value: tr.amount.0, data: &[] };
    assert_eq!(p.payload_hash, eth::hex_encode(&expected.signing_hash()));

    let mpc = receipts.iter().find(|r| r.receiver_id == acc("v1.signer-prod.testnet")).expect("MPC receipt");
    let args = match &mpc.actions[0] {
        near_sdk::mock::MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. } => {
            assert_eq!(method_name, b"sign");
            assert_eq!(attached_deposit.as_yoctonear(), 1);
            String::from_utf8(args.clone()).unwrap()
        }
        other => panic!("unexpected action {other:?}"),
    };
    assert!(args.contains(&format!(r#""payload_v2":{{"Ecdsa":"{}"}}"#, p.payload_hash)), "{args}");
    assert!(args.contains(r#""path":"behest/v1/owner.testnet/eth""#), "{args}");
    assert!(args.contains(r#""domain_id":0"#), "{args}");
}

#[test]
fn mpc_signature_produces_broadcastable_tx() {
    let mut e = eth_signed();
    let tr = e.eth_transfer();
    assert_eq!(tr.state, TransferState::Signed);
    let i = e.eth_index();
    let raw = e.as_("anyone.testnet", 0).get_signed_tx(acc("owner.testnet"), i).unwrap();
    assert!(raw.starts_with("0x02f8"));
    assert!(raw.contains(&AMARA_ETH[2..]));
    assert!(raw.ends_with(S));
}

#[test]
fn mpc_failure_marks_transfer_failed() {
    let mut e = eth_claimed();
    let i = e.eth_index();
    e.callback(vec![PromiseResult::Failed]).on_eth_signed(acc("owner.testnet"), i, 1);
    let tr = e.eth_transfer();
    assert_eq!(tr.state, TransferState::Failed);
    assert_eq!(tr.failure.as_deref(), Some("SignFailed"));
}

#[test]
fn malformed_mpc_response_is_a_failure() {
    let mut e = eth_claimed();
    let i = e.eth_index();
    e.callback(vec![mpc_ok("02ab", S, 0)]).on_eth_signed(acc("owner.testnet"), i, 1);
    assert_eq!(e.eth_transfer().state, TransferState::Failed);
}

#[test]
fn retry_keeps_nonce_recipient_value_and_bumps_fees() {
    let mut e = eth_claimed();
    let i = e.eth_index();
    e.callback(vec![PromiseResult::Failed]).on_eth_signed(acc("owner.testnet"), i, 1);
    let before = e.eth_transfer();
    let _ = e.as_("amara.testnet", 0).retry_transfer(acc("owner.testnet"), i);
    let after = e.eth_transfer();
    let (b, a) = (before.eth_tx.unwrap(), after.eth_tx.clone().unwrap());
    assert_eq!(after.state, TransferState::Signing);
    assert_eq!(after.attempts, 2);
    assert_eq!(a.nonce, b.nonce);
    assert_eq!((after.destination, after.amount), (before.destination, before.amount));
    assert_eq!(a.max_fee_per_gas.0, eth::bump(b.max_fee_per_gas.0, 50 * GWEI));
    assert_ne!(a.payload_hash, b.payload_hash);
    assert_eq!(e.plan().eth_next_nonce, 1, "retry must not consume a new nonce");
}

#[test]
fn stale_mpc_callback_is_ignored() {
    let mut e = eth_claimed();
    let i = e.eth_index();
    e.callback(vec![PromiseResult::Failed]).on_eth_signed(acc("owner.testnet"), i, 1);
    let _ = e.as_("amara.testnet", 0).retry_transfer(acc("owner.testnet"), i);
    // A late response for attempt 1 must not attach a signature to attempt 2.
    e.callback(vec![mpc_ok(BIG_R, S, 1)]).on_eth_signed(acc("owner.testnet"), i, 1);
    let tr = e.eth_transfer();
    assert_eq!(tr.state, TransferState::Signing);
    assert!(tr.signature.is_none());
}

#[test]
fn repeated_retries_never_exceed_fee_cap() {
    let mut e = eth_claimed();
    let i = e.eth_index();
    for attempt in 1..=12 {
        e.callback(vec![PromiseResult::Failed]).on_eth_signed(acc("owner.testnet"), i, attempt);
        let _ = e.as_("amara.testnet", 0).retry_transfer(acc("owner.testnet"), i);
    }
    let p = e.eth_transfer().eth_tx.unwrap();
    assert_eq!(p.max_fee_per_gas.0, 50 * GWEI);
    assert!(p.max_priority_fee_per_gas.0 <= p.max_fee_per_gas.0);
    assert_eq!(p.nonce, 0);
}

#[test]
#[should_panic(expected = "E_INVALID_TRANSFER_STATE")]
fn cannot_retry_a_transfer_in_flight() {
    let mut e = eth_claimed();
    let i = e.eth_index();
    let _ = e.as_("amara.testnet", 0).retry_transfer(acc("owner.testnet"), i);
}

#[test]
#[should_panic(expected = "E_UNAUTHORIZED")]
fn other_heir_cannot_retry() {
    let mut e = eth_claimed();
    let i = e.eth_index();
    e.callback(vec![PromiseResult::Failed]).on_eth_signed(acc("owner.testnet"), i, 1);
    let _ = e.as_("tobi.testnet", 0).retry_transfer(acc("owner.testnet"), i);
}

#[test]
fn second_claim_does_not_resign_eth() {
    let mut e = eth_claimed();
    let _ = e.as_("amara.testnet", 0).claim(acc("owner.testnet"));
    assert_eq!(e.eth_transfer().attempts, 1);
    assert_eq!(e.plan().eth_next_nonce, 1);
}

#[test]
fn executor_reports_drive_eth_to_confirmed_and_plan_settles() {
    let mut e = eth_signed();
    e.as_("admin.testnet", 0).add_executor(acc("exec.testnet"));
    let i = e.eth_index();
    let owner = acc("owner.testnet");
    e.as_("exec.testnet", 0).report_broadcast(owner.clone(), i, "0xabc".into());
    assert_eq!(e.eth_transfer().state, TransferState::Broadcast);
    e.as_("exec.testnet", 0).report_confirmed(owner.clone(), i, "0xabc".into());
    e.as_("exec.testnet", 0).report_confirmed(owner.clone(), i, "0xabc".into()); // idempotent
    assert_eq!(e.eth_transfer().state, TransferState::Confirmed);

    // Settle NEAR transfers through their callbacks.
    let near_idx: Vec<u32> = e.plan().proposal.unwrap().transfers.iter().enumerate().filter(|(_, t)| t.asset == Asset::Near).map(|(k, _)| k as u32).collect();
    let _ = e.as_("tobi.testnet", 0).claim(owner.clone());
    for k in near_idx {
        e.callback(vec![PromiseResult::Successful(vec![])]).on_near_transfer(owner.clone(), k);
    }
    assert_eq!(e.status(), PlanStatus::Settled);
    assert!(e.as_("x.testnet", 0).list_open_releases(None, None).is_empty());
}

#[test]
#[should_panic(expected = "E_INVALID_TRANSFER_STATE")]
fn executor_cannot_confirm_a_different_hash() {
    let mut e = eth_signed();
    e.as_("admin.testnet", 0).add_executor(acc("exec.testnet"));
    let i = e.eth_index();
    e.as_("exec.testnet", 0).report_broadcast(acc("owner.testnet"), i, "0xabc".into());
    e.as_("exec.testnet", 0).report_confirmed(acc("owner.testnet"), i, "0xdef".into());
}

#[test]
#[should_panic(expected = "E_UNAUTHORIZED")]
fn non_executor_cannot_report() {
    let mut e = eth_signed();
    let i = e.eth_index();
    e.as_("amara.testnet", 0).report_broadcast(acc("owner.testnet"), i, "0xabc".into());
}

#[test]
fn executor_failure_then_retry_resigns_same_nonce() {
    let mut e = eth_signed();
    e.as_("admin.testnet", 0).add_executor(acc("exec.testnet"));
    let i = e.eth_index();
    e.as_("exec.testnet", 0).report_failed(acc("owner.testnet"), i, "FeeAboveCap".into());
    assert_eq!(e.eth_transfer().failure.as_deref(), Some("FeeAboveCap"));
    let _ = e.as_("exec.testnet", 0).retry_transfer(acc("owner.testnet"), i);
    let tr = e.eth_transfer();
    assert_eq!((tr.state, tr.eth_tx.unwrap().nonce), (TransferState::Signing, 0));
}

#[test]
fn near_transfer_failure_is_retryable_via_claim() {
    let mut e = approved();
    e.advance(30 * DAY);
    let owner = acc("owner.testnet");
    let _ = e.as_("tobi.testnet", 0).claim(owner.clone());
    let k = e.plan().proposal.unwrap().transfers.iter().position(|t| t.heir == acc("tobi.testnet")).unwrap() as u32;
    e.callback(vec![PromiseResult::Failed]).on_near_transfer(owner.clone(), k);
    assert_eq!(e.plan().proposal.unwrap().transfers[k as usize].state, TransferState::Failed);
    let _ = e.as_("tobi.testnet", 0).claim(owner);
    assert_eq!(e.plan().proposal.unwrap().transfers[k as usize].state, TransferState::Sending);
}

#[test]
fn vault_path_is_per_owner() {
    let mut e = Env::new();
    assert_eq!(e.as_("x.testnet", 0).get_eth_vault_path(acc("owner.testnet")), "behest/v1/owner.testnet/eth");
}

#[test]
fn open_release_index_tracks_proposals() {
    let mut e = funded_overdue();
    let id = e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), None, None, None);
    assert_eq!(e.as_("x.testnet", 0).list_open_releases(None, None), vec![acc("owner.testnet")]);
    e.as_("g2.testnet", 0).reject_release(acc("owner.testnet"), id);
    e.as_("g3.testnet", 0).reject_release(acc("owner.testnet"), id);
    assert!(e.as_("x.testnet", 0).list_open_releases(None, None).is_empty());
    e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), None, None, None);
    e.as_("owner.testnet", 0).cancel_release();
    assert!(e.as_("x.testnet", 0).list_open_releases(None, None).is_empty());
}

#[test]
fn every_signed_version_is_kept_for_reconciliation() {
    let mut e = eth_signed();
    e.as_("admin.testnet", 0).add_executor(acc("exec.testnet"));
    let i = e.eth_index();
    let owner = acc("owner.testnet");
    let v1 = e.as_("x.testnet", 0).get_signed_tx(owner.clone(), i).unwrap();
    e.as_("exec.testnet", 0).report_failed(owner.clone(), i, "Stuck".into());
    let _ = e.as_("exec.testnet", 0).retry_transfer(owner.clone(), i);
    e.callback(vec![mpc_ok(BIG_R, S, 0)]).on_eth_signed(owner.clone(), i, 2);
    let v2 = e.as_("x.testnet", 0).get_signed_tx(owner.clone(), i).unwrap();
    assert_ne!(v1, v2);
    assert_eq!(e.as_("x.testnet", 0).get_signed_tx_versions(owner.clone(), i), vec![v1, v2]);
    // A late duplicate callback for the same payload does not add a version.
    assert_eq!(e.eth_transfer().signed_versions.len(), 2);
}

#[test]
fn claim_schedules_independent_chains_for_near_and_eth() {
    // Regression: returning `near.and(eth)` is rejected on-chain
    // ("Returning joint promise is currently prohibited").
    let mut e = approved();
    e.advance(30 * DAY);
    let started = e.as_("amara.testnet", 0).claim(acc("owner.testnet"));
    let receipts = near_sdk::test_utils::get_created_receipts();
    assert_eq!(started, 2);
    assert!(receipts.iter().any(|r| r.receiver_id == acc("amara.testnet")), "NEAR transfer scheduled");
    assert!(receipts.iter().any(|r| r.receiver_id == acc("v1.signer-prod.testnet")), "MPC sign scheduled");
}

// ------------------------------------------------------ gas limit and upgrade

#[test]
fn gas_limit_is_snapshotted_into_the_proposal() {
    let mut e = funded_overdue();
    e.as_("admin.testnet", 0).set_eth_gas_limit(250_000);
    let id = e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), Some(U128(NEAR)), None, None);
    e.as_("g2.testnet", 0).approve_release(acc("owner.testnet"), id);
    // reserve = 1 ETH heir × 250k gas × 50 gwei cap
    let p = e.plan().proposal.unwrap();
    assert_eq!((p.eth_gas_limit, p.eth_fee_reserve.0), (250_000, 250_000 * 50 * GWEI));

    // Raising the limit later doesn't change what this proposal signs.
    e.as_("admin.testnet", 0).set_eth_gas_limit(400_000);
    e.advance(30 * DAY);
    let _ = e.as_("amara.testnet", 0).claim(acc("owner.testnet"));
    let tr = e.eth_transfer();
    let params = tr.eth_tx.clone().unwrap();
    assert_eq!(params.gas_limit, 250_000);
    let to = eth::parse_address(&tr.destination).unwrap();
    let expected = eth::EthTransfer { chain_id: 11155111, nonce: 0, max_priority_fee_per_gas: 2 * GWEI, max_fee_per_gas: 20 * GWEI, gas_limit: 250_000, to: &to, value: tr.amount.0, data: &[] };
    assert_eq!(params.payload_hash, eth::hex_encode(&expected.signing_hash()));
}

#[test]
#[should_panic(expected = "E_BAD_GAS_LIMIT")]
fn gas_limit_bounds_enforced() {
    let mut e = Env::new();
    e.as_("admin.testnet", 0).set_eth_gas_limit(1_000);
}

#[test]
#[should_panic(expected = "E_UNAUTHORIZED")]
fn only_admin_sets_gas_limit() {
    let mut e = Env::new();
    e.as_("g1.testnet", 0).set_eth_gas_limit(300_000);
}

fn eth_reverted() -> Env {
    let mut e = eth_signed();
    e.as_("admin.testnet", 0).add_executor(acc("exec.testnet"));
    let i = e.eth_index();
    let h = e.signed_hash(i);
    e.as_("exec.testnet", 0).report_broadcast(acc("owner.testnet"), i, h);
    e.as_("exec.testnet", 0).report_failed(acc("owner.testnet"), i, "Reverted".into());
    e
}

const BLOCK: &str = "0x190ca72931856dac06c846b56cc36c7b2a17a413f10674e2cc4875c09346942b";

impl Env {
    /// Hash of the transfer's current signed transaction.
    fn signed_hash(&mut self, i: u32) -> String {
        let raw = self.c.get_signed_tx(acc("owner.testnet"), i).unwrap();
        let b = crate::eth::hex_decode(raw.trim_start_matches("0x")).unwrap();
        format!("0x{}", crate::eth::hex_encode(&env::keccak256_array(&b)))
    }
    /// The light-client callback of `prove_eth_outcome`, as if the proofs
    /// checked out; `final_hash` is what `block_hash_safe` answered.
    fn proven(&mut self, i: u32, tx: String, success: bool, final_hash: Option<&str>) -> bool {
        let answer = match final_hash {
            Some(h) => [vec![1u8], crate::eth::hex_decode(h.trim_start_matches("0x")).unwrap()].concat(),
            None => vec![0u8],
        };
        self.callback(vec![PromiseResult::Successful(answer)]).on_eth_outcome_checked(acc("owner.testnet"), i, tx, BLOCK.into(), success)
    }
}

fn eth_proven_revert() -> Env {
    let mut e = eth_reverted();
    let i = e.eth_index();
    let h = e.signed_hash(i);
    assert!(e.proven(i, h, false, Some(BLOCK)));
    e
}

#[test]
fn reverted_transfer_is_reissued_on_a_fresh_nonce_with_current_gas() {
    let mut e = eth_proven_revert();
    e.as_("admin.testnet", 0).set_eth_gas_limit(250_000);
    let i = e.eth_index();
    // once proven, anyone may re-issue: an heir here
    let _ = e.as_("amara.testnet", 0).reissue_reverted_transfer(acc("owner.testnet"), i);
    let tr = e.eth_transfer();
    let p = tr.eth_tx.unwrap();
    assert_eq!((tr.state, p.nonce, p.gas_limit, p.max_fee_per_gas.0), (TransferState::Signing, 1, 250_000, 20 * GWEI));
    assert_eq!(e.plan().eth_next_nonce, 2);
    // the reverted version stays on record
    assert_eq!(tr.signed_versions.len(), 1);
}

#[test]
#[should_panic(expected = "E_REVERT_NOT_PROVEN")]
fn reissue_needs_a_proven_revert() {
    // the executor's (or anyone's) report of a revert isn't enough (D22, threat 20)
    let mut e = eth_reverted();
    let i = e.eth_index();
    let _ = e.as_("admin.testnet", 0).reissue_reverted_transfer(acc("owner.testnet"), i);
}

#[test]
#[should_panic(expected = "E_INVALID_TRANSFER_STATE")]
fn reissue_needs_a_reverted_transfer() {
    let mut e = eth_signed();
    let i = e.eth_index();
    let _ = e.as_("admin.testnet", 0).reissue_reverted_transfer(acc("owner.testnet"), i);
}

#[test]
fn reverted_transfer_cannot_be_retried_on_the_same_nonce() {
    let mut e = eth_reverted();
    let i = e.eth_index();
    // `retry_transfer` keeps the nonce; a mined nonce can't be reused, so the
    // executor never auto-retries "Reverted" (it isn't in AUTO_RETRY). The
    // contract still allows a manual retry, which keeps nonce 0.
    let _ = e.as_("amara.testnet", 0).retry_transfer(acc("owner.testnet"), i);
    assert_eq!(e.eth_transfer().eth_tx.unwrap().nonce, 0);
}

#[test]
fn v1_state_migrates_lazily() {
    use crate::legacy::{ContractV1, PlanV1, ProposalV1, TransferV1};
    let mut e = Env::new();
    let mut plans = near_sdk::store::LookupMap::new(StorageKey::Plans);
    let owner = acc("owner.testnet");
    plans.insert(
        owner.clone(),
        PlanV1 {
            owner: owner.clone(),
            version: 1,
            policy: plan_input(),
            last_check_in_ms: 0,
            escrow: U128(3 * NEAR),
            eth_next_nonce: 2,
            proposals_opened: 1,
            proposal: Some(ProposalV1 {
                id: 1,
                plan_version: 1,
                proposer: acc("g1.testnet"),
                created_at_ms: 0,
                approvals: vec![acc("g1.testnet"), acc("g2.testnet")],
                rejections: vec![],
                approved_at_ms: Some(0),
                waiting_ends_at_ms: Some(0),
                near_snapshot: U128(0),
                eth_snapshot: U128(NEAR),
                eth_fee_reserve: U128(21_000 * 50 * GWEI),
                transfers: vec![TransferV1 {
                    heir: acc("amara.testnet"),
                    asset: Asset::Eth,
                    destination: AMARA_ETH.into(),
                    amount: U128(1_000),
                    state: TransferState::Failed,
                    eth_tx: None,
                    signature: None,
                    signed_versions: vec![],
                    attempts: 1,
                    tx_hash: Some("0xabcd".into()),
                    failure: Some("Reverted".into()),
                }],
            }),
        },
    );
    plans.flush();
    let mut execs = near_sdk::store::IterableSet::new(StorageKey::Executors);
    execs.insert(acc("exec.testnet"));
    execs.flush();
    let old = ContractV1 {
        admin: acc("admin.testnet"),
        mpc_contract: acc("v1.signer-prod.testnet"),
        eth_chain_id: 11155111,
        eth_max_fee_cap: U128(50 * GWEI),
        eth_initial_max_fee: U128(20 * GWEI),
        eth_priority_fee: U128(2 * GWEI),
        paused: false,
        executors: execs,
        open_releases: near_sdk::store::IterableSet::new(StorageKey::OpenReleases),
        plans,
    };
    env::state_write(&old);

    e.c = Contract::migrate(250_000);
    let cfg = e.c.get_config();
    assert_eq!((cfg.eth_gas_limit, cfg.executors), (250_000, vec![acc("exec.testnet")]));

    // read without writing: old transfers report the 21k they were built with
    let view = e.c.get_plan(owner.clone()).unwrap();
    assert_eq!((view.plan.escrow.0, view.plan.eth_next_nonce), (3 * NEAR, 2));
    assert_eq!(view.plan.proposal.as_ref().unwrap().eth_gas_limit, 21_000);

    // first write moves it, and a reissue picks up the new gas limit and nonce 2
    // a v0.1 transfer has no signed versions to prove against; record the proof directly
    env::storage_write(b"rvp:owner.testnet:0", &[0xab, 0xcd]);
    let _ = e.as_("admin.testnet", 0).reissue_reverted_transfer(owner.clone(), 0);
    let p = e.plan().proposal.unwrap();
    assert_eq!((p.eth_gas_limit, p.transfers[0].eth_tx.as_ref().unwrap().nonce), (250_000, 2));
}

#[test]
fn retry_after_gas_limit_too_low_keeps_nonce_and_raises_gas() {
    let mut e = eth_signed();
    e.as_("admin.testnet", 0).add_executor(acc("exec.testnet"));
    let i = e.eth_index();
    e.as_("exec.testnet", 0).report_failed(acc("owner.testnet"), i, "GasLimitTooLow".into());
    e.as_("admin.testnet", 0).set_eth_gas_limit(300_000);
    let _ = e.as_("amara.testnet", 0).retry_transfer(acc("owner.testnet"), i);
    let p = e.eth_transfer().eth_tx.unwrap();
    assert_eq!((p.nonce, p.gas_limit), (0, 300_000));
    assert_eq!(e.plan().eth_next_nonce, 1);
}

// ------------------------------------------------- substitution and replay

#[test]
#[should_panic(expected = "E_NOT_PROPOSED")]
fn approval_for_a_cancelled_proposal_cannot_be_replayed_on_the_next() {
    let mut e = funded_overdue();
    let old = e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), Some(U128(NEAR)), None, None);
    e.as_("owner.testnet", 0).cancel_release();
    e.advance(97 * DAY);
    let new = e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), Some(U128(NEAR)), None, None);
    assert_ne!(old, new);
    e.as_("g2.testnet", 0).approve_release(acc("owner.testnet"), old);
}

#[test]
fn edited_destinations_need_a_fresh_proposal_and_fresh_votes() {
    let mut e = funded_overdue();
    let id = e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), Some(U128(NEAR)), None, None);
    e.as_("owner.testnet", 0).cancel_release();
    let mut edited = plan_input();
    edited.heirs[0].eth_destination = Some("0x000000000000000000000000000000000000dead".into());
    e.as_("owner.testnet", NEAR).set_plan(edited);
    e.advance(97 * DAY);
    let id2 = e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), Some(U128(NEAR)), None, None);
    let p = e.plan().proposal.unwrap();
    // votes don't carry over (only the proposer's own), and the snapshot pins the version
    assert!(id2 > id);
    assert_eq!((p.approvals.clone(), p.plan_version), (vec![acc("g1.testnet")], 2));
    assert!(p.transfers.iter().any(|t| t.destination == "0x000000000000000000000000000000000000dead"));
}

#[test]
#[should_panic(expected = "E_NOT_PROPOSED")]
fn no_votes_after_quorum() {
    let mut e = approved();
    let id = e.plan().proposal.unwrap().id;
    e.as_("g3.testnet", 0).approve_release(acc("owner.testnet"), id);
}

#[test]
fn claim_ignores_any_extra_destination_or_amount_arguments() {
    // `claim` takes only `owner`; the transfer is the snapshot, whatever the
    // caller sends. Unknown JSON fields are dropped by the ABI, so the only
    // inputs are the caller (must be the heir) and the owner.
    let mut e = approved();
    e.advance(30 * DAY);
    let before = e.plan().proposal.unwrap().transfers;
    let _ = e.as_("amara.testnet", 0).claim(acc("owner.testnet"));
    let after = e.plan().proposal.unwrap().transfers;
    for (b, a) in before.iter().zip(after.iter()) {
        assert_eq!((&b.heir, &b.destination, b.amount, &b.asset), (&a.heir, &a.destination, a.amount, &a.asset));
    }
}

// ------------------------------------------------------------------ ERC-20

const WETH: &str = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";
const PER_TX: u128 = 21_000 * 50 * GWEI;

fn weth() -> String {
    WETH.to_ascii_lowercase()
}

fn with_weth() -> Env {
    let mut e = funded_overdue();
    e.as_("admin.testnet", 0).set_erc20_tokens(vec![Erc20Token { address: WETH.into(), symbol: "WETH".into(), decimals: 18 }]);
    e
}

fn bal(token: &str, amount: u128) -> Option<Vec<TokenBalance>> {
    Some(vec![TokenBalance { token: token.into(), amount: U128(amount) }])
}

#[test]
fn erc20_encoding_matches_viem() {
    // Reference from viem 2.57.16: encodeFunctionData(erc20Abi, "transfer") + serializeTransaction.
    testing_env!(VMContextBuilder::new().build());
    let token = eth::parse_address(&weth()).unwrap();
    let data = eth::erc20_transfer_data(&eth::parse_address(AMARA_ETH).unwrap(), 3_000_000_000_000_000);
    assert_eq!(
        eth::hex_encode(&data),
        "a9059cbb00000000000000000000000071c7656ec7ab88b098defb751b7401b5f6d8976f000000000000000000000000000000000000000000000000000aa87bee538000"
    );
    let tx = eth::EthTransfer { chain_id: 11155111, nonce: 1, max_priority_fee_per_gas: 2 * GWEI, max_fee_per_gas: 20 * GWEI, gas_limit: 250_000, to: &token, value: 0, data: &data };
    assert_eq!(
        eth::hex_encode(&tx.unsigned()),
        "02f87183aa36a70184773594008504a817c8008303d09094fff9976782d46cc05630d1f6ebab18b2324d6b1480b844a9059cbb00000000000000000000000071c7656ec7ab88b098defb751b7401b5f6d8976f000000000000000000000000000000000000000000000000000aa87bee538000c0"
    );
    assert_eq!(eth::hex_encode(&tx.signing_hash()), "1bd0e4845d718fab15d89e53259dd16643157a89b41134e154d1b68749a2ed28");
}

#[test]
fn token_snapshot_reserves_a_fee_for_every_vault_transaction() {
    let mut e = with_weth();
    e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), Some(U128(NEAR)), bal(WETH, 1_000), None);
    let p = e.plan().proposal.unwrap();
    // amara (the only ETH heir) gets one ETH and one WETH transfer: two reserved fees
    assert_eq!(p.eth_fee_reserve.0, 2 * PER_TX);
    let evm: Vec<_> = p.transfers.iter().filter(|t| t.asset.is_evm()).map(|t| (t.asset.clone(), t.amount.0)).collect();
    assert_eq!(evm, vec![(Asset::Eth, policy::share_of(NEAR - 2 * PER_TX, 6000)), (Asset::Erc20(weth()), 600)]);
}

#[test]
fn token_only_vault_needs_eth_for_gas_but_not_more() {
    let mut e = with_weth();
    e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), Some(U128(PER_TX)), bal(WETH, 1_000), None);
    let p = e.plan().proposal.unwrap();
    assert_eq!(p.eth_fee_reserve.0, PER_TX);
    assert!(p.transfers.iter().all(|t| t.asset != Asset::Eth));
    assert!(p.transfers.iter().any(|t| t.asset == Asset::Erc20(weth())));
}

#[test]
#[should_panic(expected = "E_INSUFFICIENT_FEE_RESERVE")]
fn token_transfers_without_gas_money_are_rejected() {
    let mut e = with_weth();
    e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), Some(U128(PER_TX - 1)), bal(WETH, 1_000), None);
}

#[test]
#[should_panic(expected = "E_UNKNOWN_TOKEN")]
fn unlisted_token_is_rejected() {
    let mut e = with_weth();
    e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), Some(U128(NEAR)), bal("0x000000000000000000000000000000000000dead", 5), None);
}

#[test]
#[should_panic(expected = "E_UNKNOWN_TOKEN")]
fn token_cannot_be_reported_twice() {
    let mut e = with_weth();
    let twice = Some(vec![TokenBalance { token: WETH.into(), amount: U128(1) }, TokenBalance { token: weth(), amount: U128(1) }]);
    e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), Some(U128(NEAR)), twice, None);
}

#[test]
#[should_panic(expected = "E_UNAUTHORIZED")]
fn only_admin_sets_tokens() {
    let mut e = Env::new();
    e.as_("g1.testnet", 0).set_erc20_tokens(vec![]);
}

#[test]
fn token_claim_signs_a_transfer_call_on_the_next_nonce() {
    let mut e = with_weth();
    let id = e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), Some(U128(NEAR)), bal(WETH, 1_000), None);
    e.as_("g2.testnet", 0).approve_release(acc("owner.testnet"), id);
    e.advance(30 * DAY);
    let _ = e.as_("amara.testnet", 0).claim(acc("owner.testnet"));
    let p = e.plan().proposal.unwrap();
    let ti = p.transfers.iter().position(|t| t.asset == Asset::Erc20(weth())).unwrap();
    let tr = &p.transfers[ti];
    let (eth_nonce, token_nonce) = (e.eth_transfer().eth_tx.unwrap().nonce, tr.eth_tx.as_ref().unwrap().nonce);
    assert_eq!((eth_nonce, token_nonce), (0, 1));

    // the signed payload is a call to the token contract with value 0
    let token = eth::parse_address(&weth()).unwrap();
    let data = eth::erc20_transfer_data(&eth::parse_address(AMARA_ETH).unwrap(), 600);
    let expected = eth::EthTransfer { chain_id: 11155111, nonce: 1, max_priority_fee_per_gas: 2 * GWEI, max_fee_per_gas: 20 * GWEI, gas_limit: 21_000, to: &token, value: 0, data: &data };
    assert_eq!(tr.eth_tx.as_ref().unwrap().payload_hash, eth::hex_encode(&expected.signing_hash()));

    e.callback(vec![mpc_ok(BIG_R, S, 1)]).on_eth_signed(acc("owner.testnet"), ti as u32, 1);
    let raw = e.as_("anyone.testnet", 0).get_signed_tx(acc("owner.testnet"), ti as u32).unwrap();
    assert!(raw.contains(&weth()[2..]) && raw.contains(&eth::hex_encode(&data)));
}

#[test]
fn removing_a_token_from_the_allowlist_keeps_open_snapshots() {
    let mut e = with_weth();
    e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), Some(U128(NEAR)), bal(WETH, 1_000), None);
    e.as_("admin.testnet", 0).set_erc20_tokens(vec![]);
    assert!(e.plan().proposal.unwrap().transfers.iter().any(|t| t.asset == Asset::Erc20(weth())));
    assert!(e.as_("anyone.testnet", 0).get_config().erc20_tokens.is_empty());
}

// ------------------------------------------------------- vault withdrawal (D7)

const OWNER_ETH: &str = "0x00000000000000000000000000000000000000aa";
const W: u32 = VAULT_WITHDRAWAL;

fn planned() -> Env {
    let mut e = Env::new();
    e.as_("owner.testnet", NEAR).set_plan(plan_input());
    e
}

fn withdrawal(e: &mut Env) -> Transfer {
    e.as_("anyone.testnet", 0).get_vault_withdrawal(acc("owner.testnet")).unwrap()
}

fn withdraw_eth(e: &mut Env, wei: u128) {
    let _ = e.as_("owner.testnet", 0).withdraw_vault(Asset::Eth, U128(wei), OWNER_ETH.into());
}

/// Withdrawal signed by the MPC, then broadcast and confirmed by the executor.
fn confirm_withdrawal(e: &mut Env) {
    let attempt = withdrawal(e).attempts;
    e.callback(vec![mpc_ok(BIG_R, S, 1)]).on_eth_signed(acc("owner.testnet"), W, attempt);
    e.as_("exec.testnet", 0).report_broadcast(acc("owner.testnet"), W, "0xw".into());
    e.as_("exec.testnet", 0).report_confirmed(acc("owner.testnet"), W, "0xw".into());
}

impl Env {
    fn with_executor(mut self) -> Self {
        self.as_("admin.testnet", 0).add_executor(acc("exec.testnet"));
        self
    }
}

#[test]
fn owner_withdraws_eth_on_the_next_vault_nonce() {
    let mut e = planned();
    withdraw_eth(&mut e, 5 * GWEI);
    let w = withdrawal(&mut e);
    assert_eq!((w.state, w.heir.as_str(), w.destination.as_str()), (TransferState::Signing, "owner.testnet", OWNER_ETH));
    let tx = w.eth_tx.unwrap();
    assert_eq!(tx.nonce, 0);
    let to = eth::parse_address(OWNER_ETH).unwrap();
    let expected = eth::EthTransfer { chain_id: 11155111, nonce: 0, max_priority_fee_per_gas: 2 * GWEI, max_fee_per_gas: 20 * GWEI, gas_limit: 21_000, to: &to, value: 5 * GWEI, data: &[] };
    assert_eq!(tx.payload_hash, eth::hex_encode(&expected.signing_hash()));
    assert_eq!(e.plan().eth_next_nonce, 1);
    assert_eq!(e.as_("x.testnet", 0).list_vault_withdrawals(), vec![acc("owner.testnet")]);
}

#[test]
fn token_withdrawal_signs_a_transfer_call() {
    let mut e = planned();
    let _ = e.as_("owner.testnet", 0).withdraw_vault(Asset::Erc20(WETH.into()), U128(7), OWNER_ETH.into());
    let w = withdrawal(&mut e);
    assert_eq!(w.asset, Asset::Erc20(weth()));
    let token = eth::parse_address(&weth()).unwrap();
    let data = eth::erc20_transfer_data(&eth::parse_address(OWNER_ETH).unwrap(), 7);
    let expected = eth::EthTransfer { chain_id: 11155111, nonce: 0, max_priority_fee_per_gas: 2 * GWEI, max_fee_per_gas: 20 * GWEI, gas_limit: 21_000, to: &token, value: 0, data: &data };
    assert_eq!(w.eth_tx.unwrap().payload_hash, eth::hex_encode(&expected.signing_hash()));
}

#[test]
#[should_panic(expected = "E_PROPOSAL_OPEN")]
fn no_withdrawal_while_a_release_is_open() {
    let mut e = approved();
    withdraw_eth(&mut e, 1);
}

#[test]
#[should_panic(expected = "E_VAULT_BUSY")]
fn one_withdrawal_at_a_time() {
    let mut e = planned();
    withdraw_eth(&mut e, 1);
    withdraw_eth(&mut e, 1);
}

#[test]
#[should_panic(expected = "E_BAD_ASSET")]
fn near_is_not_a_vault_asset() {
    let mut e = planned();
    let _ = e.as_("owner.testnet", 0).withdraw_vault(Asset::Near, U128(1), OWNER_ETH.into());
}

#[test]
#[should_panic(expected = "E_VAULT_BUSY")]
fn release_cannot_snapshot_a_vault_with_an_unresolved_withdrawal() {
    let mut e = planned();
    e.as_("owner.testnet", 10 * NEAR).deposit(acc("owner.testnet"));
    withdraw_eth(&mut e, 1);
    e.advance(97 * DAY);
    e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), Some(U128(NEAR)), None, None);
}

#[test]
fn confirmed_withdrawal_frees_the_vault_and_heirs_take_later_nonces() {
    let mut e = planned().with_executor();
    e.as_("owner.testnet", 10 * NEAR).deposit(acc("owner.testnet"));
    withdraw_eth(&mut e, 1);
    confirm_withdrawal(&mut e);
    assert_eq!(withdrawal(&mut e).state, TransferState::Confirmed);
    assert!(e.as_("x.testnet", 0).list_vault_withdrawals().is_empty());
    e.advance(97 * DAY);
    let id = e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), Some(U128(NEAR)), None, None);
    e.as_("g2.testnet", 0).approve_release(acc("owner.testnet"), id);
    e.advance(30 * DAY);
    let _ = e.as_("amara.testnet", 0).claim(acc("owner.testnet"));
    assert_eq!(e.eth_transfer().eth_tx.unwrap().nonce, 1);
}

#[test]
fn failed_withdrawal_is_cancelled_at_the_same_nonce_with_zero_value() {
    let mut e = planned().with_executor();
    withdraw_eth(&mut e, 5 * GWEI);
    e.callback(vec![mpc_ok(BIG_R, S, 1)]).on_eth_signed(acc("owner.testnet"), W, 1);
    e.as_("exec.testnet", 0).report_failed(acc("owner.testnet"), W, "WouldRevert".into());
    let _ = e.as_("exec.testnet", 0).cancel_vault_withdrawal(acc("owner.testnet"));
    let w = withdrawal(&mut e);
    assert_eq!((w.asset.clone(), w.amount.0, w.attempts, w.state), (Asset::Eth, 0, 2, TransferState::Signing));
    assert_eq!(w.eth_tx.as_ref().unwrap().nonce, 0);
    assert!(w.signed_versions.is_empty());
    assert_eq!(e.plan().eth_next_nonce, 1, "no new nonce taken");
    confirm_withdrawal(&mut e);
    assert!(e.as_("x.testnet", 0).list_vault_withdrawals().is_empty());
}

#[test]
#[should_panic(expected = "E_INVALID_TRANSFER_STATE")]
fn cannot_cancel_a_withdrawal_that_was_broadcast() {
    let mut e = planned().with_executor();
    withdraw_eth(&mut e, 5 * GWEI);
    e.callback(vec![mpc_ok(BIG_R, S, 1)]).on_eth_signed(acc("owner.testnet"), W, 1);
    e.as_("exec.testnet", 0).report_broadcast(acc("owner.testnet"), W, "0xw".into());
    e.as_("exec.testnet", 0).report_failed(acc("owner.testnet"), W, "Stuck".into());
    let _ = e.as_("owner.testnet", 0).cancel_vault_withdrawal(acc("owner.testnet"));
}

#[test]
#[should_panic(expected = "E_UNAUTHORIZED")]
fn strangers_cannot_cancel_a_withdrawal() {
    let mut e = planned().with_executor();
    withdraw_eth(&mut e, 5 * GWEI);
    e.callback(vec![mpc_ok(BIG_R, S, 1)]).on_eth_signed(acc("owner.testnet"), W, 1);
    e.as_("exec.testnet", 0).report_failed(acc("owner.testnet"), W, "WouldRevert".into());
    let _ = e.as_("g1.testnet", 0).cancel_vault_withdrawal(acc("owner.testnet"));
}

#[test]
fn owner_or_executor_retries_a_withdrawal_at_the_same_nonce() {
    let mut e = planned().with_executor();
    withdraw_eth(&mut e, 5 * GWEI);
    e.callback(vec![mpc_ok(BIG_R, S, 1)]).on_eth_signed(acc("owner.testnet"), W, 1);
    e.as_("exec.testnet", 0).report_failed(acc("owner.testnet"), W, "FeeAboveCap".into());
    let _ = e.as_("exec.testnet", 0).retry_transfer(acc("owner.testnet"), W);
    let w = withdrawal(&mut e);
    assert_eq!((w.eth_tx.unwrap().nonce, w.attempts, w.amount.0), (0, 2, 5 * GWEI));
}

#[test]
fn signed_withdrawal_is_readable_as_a_raw_transaction() {
    let mut e = planned();
    withdraw_eth(&mut e, 5 * GWEI);
    e.callback(vec![mpc_ok(BIG_R, S, 1)]).on_eth_signed(acc("owner.testnet"), W, 1);
    let raw = e.as_("x.testnet", 0).get_signed_tx(acc("owner.testnet"), W).unwrap();
    assert!(raw.starts_with("0x02") && raw.contains(&OWNER_ETH[2..]));
    assert_eq!(e.as_("x.testnet", 0).get_signed_tx_versions(acc("owner.testnet"), W).len(), 1);
}

// ------------------------------------------------------------------ NEP-141

const WNEAR: &str = "wrap.testnet";
const REG: u128 = 1_250_000_000_000_000_000_000; // 0.00125 NEAR

fn with_wnear() -> Env {
    let mut e = Env::new().with_executor();
    e.as_("admin.testnet", REG).set_nep141_tokens(vec![Nep141Token { account_id: acc(WNEAR), symbol: "wNEAR".into(), decimals: 24, storage_deposit: U128(REG) }]);
    e.as_("owner.testnet", NEAR).set_plan(plan_input());
    e.as_("owner.testnet", 10 * NEAR).deposit(acc("owner.testnet"));
    e
}

fn ft_deposit(e: &mut Env, token: &str, from: &str, amount: u128, msg: &str) -> u128 {
    match e.as_(token, 0).ft_on_transfer(acc(from), U128(amount), msg.into()) {
        PromiseOrValue::Value(v) => v.0,
        PromiseOrValue::Promise(_) => panic!("unexpected promise"),
    }
}

fn ft_escrow_of(e: &mut Env) -> u128 {
    e.as_("x.testnet", 0).get_plan(acc("owner.testnet")).unwrap().ft_escrow.iter().find(|b| b.token == WNEAR).map(|b| b.amount.0).unwrap_or(0)
}

fn ft_approved() -> Env {
    let mut e = with_wnear();
    assert_eq!(ft_deposit(&mut e, WNEAR, "owner.testnet", 1_000, ""), 0);
    e.advance(97 * DAY);
    let id = e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), Some(U128(NEAR)), None, None);
    e.as_("g2.testnet", 0).approve_release(acc("owner.testnet"), id);
    e
}

fn wnear_index(e: &mut Env, heir: &str) -> u32 {
    e.plan().proposal.unwrap().transfers.iter().position(|t| t.asset == Asset::Nep141(acc(WNEAR)) && t.heir.as_str() == heir).unwrap() as u32
}

#[test]
fn allowlisted_token_deposit_is_credited_to_the_plan_named_in_msg() {
    let mut e = with_wnear();
    assert_eq!(ft_deposit(&mut e, WNEAR, "friend.testnet", 700, "owner.testnet"), 0);
    assert_eq!(ft_escrow_of(&mut e), 700);
}

#[test]
fn deposits_that_cannot_be_accepted_are_refunded() {
    let mut e = with_wnear();
    assert_eq!(ft_deposit(&mut e, "evil.testnet", "owner.testnet", 5, ""), 5, "unlisted token");
    assert_eq!(ft_deposit(&mut e, WNEAR, "nobody.testnet", 5, ""), 5, "no plan");
    assert_eq!(ft_deposit(&mut e, WNEAR, "owner.testnet", 5, "not an account!"), 5, "bad msg");
    e.advance(97 * DAY);
    e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), Some(U128(NEAR)), None, None);
    assert_eq!(ft_deposit(&mut e, WNEAR, "owner.testnet", 5, ""), 5, "release open");
    assert_eq!(ft_escrow_of(&mut e), 0);
}

#[test]
fn release_splits_tokens_and_reserves_heir_registration_from_near() {
    let mut e = ft_approved();
    let p = e.plan().proposal.unwrap();
    let ft: Vec<_> = p.transfers.iter().filter(|t| matches!(t.asset, Asset::Nep141(_))).map(|t| (t.heir.to_string(), t.destination.clone(), t.amount.0)).collect();
    assert_eq!(ft, vec![("amara.testnet".into(), "amara.testnet".into(), 600), ("tobi.testnet".into(), "tobi-wallet.testnet".into(), 400)]);
    // two registrations reserved before NEAR is split
    let near: Vec<_> = p.transfers.iter().filter(|t| t.asset == Asset::Near).map(|t| t.amount.0).collect();
    assert_eq!(near, vec![policy::share_of(10 * NEAR - 2 * REG, 6000), policy::share_of(10 * NEAR - 2 * REG, 4000)]);
    assert_eq!(ft_escrow_of(&mut e), 0);
}

#[test]
#[should_panic(expected = "E_INSUFFICIENT_FEE_RESERVE")]
fn token_release_needs_near_for_registrations() {
    let mut e = Env::new();
    e.as_("admin.testnet", REG).set_nep141_tokens(vec![Nep141Token { account_id: acc(WNEAR), symbol: "wNEAR".into(), decimals: 24, storage_deposit: U128(REG) }]);
    e.as_("owner.testnet", NEAR).set_plan(plan_input());
    e.as_("owner.testnet", REG).deposit(acc("owner.testnet"));
    ft_deposit(&mut e, WNEAR, "owner.testnet", 1_000, "");
    e.advance(97 * DAY);
    e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), None, None, None);
}

#[test]
fn token_claim_registers_once_and_retries_without_a_second_registration() {
    let mut e = ft_approved();
    e.advance(30 * DAY);
    let _ = e.as_("amara.testnet", 0).claim(acc("owner.testnet"));
    let i = wnear_index(&mut e, "amara.testnet");
    let tr = e.plan().proposal.unwrap().transfers[i as usize].clone();
    assert_eq!((tr.state, tr.attempts), (TransferState::Sending, 1));
    // one registration spent from the two reserved
    e.callback(vec![PromiseResult::Failed]).on_near_transfer(acc("owner.testnet"), i);
    assert_eq!(e.plan().proposal.unwrap().transfers[i as usize].state, TransferState::Failed);
    let _ = e.as_("amara.testnet", 0).claim(acc("owner.testnet"));
    let tr = e.plan().proposal.unwrap().transfers[i as usize].clone();
    assert_eq!((tr.state, tr.attempts), (TransferState::Sending, 2));
    e.callback(vec![PromiseResult::Successful(vec![])]).on_near_transfer(acc("owner.testnet"), i);
    assert_eq!(e.plan().proposal.unwrap().transfers[i as usize].state, TransferState::Confirmed);
}

#[test]
fn cancel_returns_tokens_and_the_registration_reserve() {
    let mut e = ft_approved();
    e.as_("owner.testnet", 0).cancel_release();
    assert_eq!(ft_escrow_of(&mut e), 1_000);
    assert_eq!(e.plan().escrow.0, 10 * NEAR);
}

#[test]
fn settling_returns_unused_registration_reserve() {
    let mut e = ft_approved();
    e.advance(30 * DAY);
    // admin raises the registration price after the proposal: the reserve no
    // longer covers it, so no registration is attempted and it is returned
    e.as_("admin.testnet", 0).set_nep141_tokens(vec![Nep141Token { account_id: acc(WNEAR), symbol: "wNEAR".into(), decimals: 24, storage_deposit: U128(10 * NEAR) }]);
    let _ = e.as_("amara.testnet", 0).claim(acc("owner.testnet"));
    let _ = e.as_("tobi.testnet", 0).claim(acc("owner.testnet"));
    let n = e.plan().proposal.unwrap().transfers.len() as u32;
    for i in 0..n {
        let t = e.plan().proposal.unwrap().transfers[i as usize].clone();
        if t.asset.is_evm() {
            continue;
        }
        e.callback(vec![PromiseResult::Successful(vec![])]).on_near_transfer(acc("owner.testnet"), i);
    }
    // the ETH transfer keeps the plan open; confirm it through the executor
    let ei = e.eth_index();
    e.callback(vec![mpc_ok(BIG_R, S, 1)]).on_eth_signed(acc("owner.testnet"), ei, 1);
    e.as_("exec.testnet", 0).report_broadcast(acc("owner.testnet"), ei, "0xe".into());
    e.as_("exec.testnet", 0).report_confirmed(acc("owner.testnet"), ei, "0xe".into());
    assert_eq!(e.status(), PlanStatus::Settled);
    let near_paid: u128 = e.plan().proposal.unwrap().transfers.iter().filter(|t| t.asset == Asset::Near).map(|t| t.amount.0).sum();
    assert_eq!(e.plan().escrow.0, 10 * NEAR - 2 * REG - near_paid + 2 * REG);
}

#[test]
fn owner_withdraws_tokens_and_a_failed_transfer_restores_escrow() {
    let mut e = with_wnear();
    ft_deposit(&mut e, WNEAR, "owner.testnet", 1_000, "");
    let _ = e.as_("owner.testnet", 0).withdraw_ft(acc(WNEAR), U128(300));
    assert_eq!(ft_escrow_of(&mut e), 700);
    e.callback(vec![PromiseResult::Failed]).on_ft_withdraw(acc("owner.testnet"), acc(WNEAR), U128(300));
    assert_eq!(ft_escrow_of(&mut e), 1_000);
}

#[test]
#[should_panic(expected = "E_INSUFFICIENT_TOKEN_ESCROW")]
fn cannot_withdraw_more_tokens_than_held() {
    let mut e = with_wnear();
    ft_deposit(&mut e, WNEAR, "owner.testnet", 10, "");
    let _ = e.as_("owner.testnet", 0).withdraw_ft(acc(WNEAR), U128(11));
}

#[test]
#[should_panic(expected = "E_PROPOSAL_OPEN")]
fn token_withdrawal_frozen_while_a_release_is_open() {
    let mut e = ft_approved();
    let _ = e.as_("owner.testnet", 0).withdraw_ft(acc(WNEAR), U128(1));
}

#[test]
#[should_panic(expected = "E_BAD_ASSET")]
fn nep141_is_not_a_vault_asset() {
    let mut e = with_wnear();
    let _ = e.as_("owner.testnet", 0).withdraw_vault(Asset::Nep141(acc(WNEAR)), U128(1), OWNER_ETH.into());
}

#[test]
#[should_panic(expected = "E_INSUFFICIENT_DEPOSIT")]
fn listing_a_token_pays_for_registering_the_contract_with_it() {
    let mut e = Env::new();
    e.as_("admin.testnet", REG - 1).set_nep141_tokens(vec![Nep141Token { account_id: acc(WNEAR), symbol: "wNEAR".into(), decimals: 24, storage_deposit: U128(REG) }]);
}

// ------------------------------------------------------------ release rules

const WINDOW: u64 = 60 * DAY;

fn outsider(id: &str, near: Option<&str>, eth: Option<&str>) -> Recipient {
    Recipient { account_id: acc(id), near_destination: near.map(acc), eth_destination: eth.map(String::from) }
}

fn rules() -> ReleaseRules {
    ReleaseRules {
        fixed: vec![FixedAmount { heir: acc("tobi.testnet"), asset: Asset::Near, amount: U128(3 * NEAR) }],
        remainder_to: Some(acc("amara.testnet")),
        alternates: vec![Alternate { heir: acc("amara.testnet"), recipient: outsider("kemi.testnet", Some("kemi.testnet"), Some("0x00000000000000000000000000000000000000bb")) }],
        fallback: Some(outsider("charity.testnet", Some("charity.testnet"), None)),
        claim_window_ms: WINDOW,
    }
}

/// Plan with `r`, 10 NEAR escrow, approved; `eth` is the reported vault balance.
fn ruled(r: ReleaseRules, eth: u128) -> Env {
    let mut e = Env::new();
    e.as_("owner.testnet", NEAR).set_plan(plan_input());
    e.as_("owner.testnet", NEAR / 100).set_release_rules(Some(r));
    e.as_("owner.testnet", 10 * NEAR).deposit(acc("owner.testnet"));
    e.advance(97 * DAY);
    let id = e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), Some(U128(eth)), None, None);
    e.as_("g2.testnet", 0).approve_release(acc("owner.testnet"), id);
    e
}

fn near_of(e: &mut Env) -> Vec<(String, u128)> {
    e.plan().proposal.unwrap().transfers.iter().filter(|t| t.asset == Asset::Near).map(|t| (t.heir.to_string(), t.amount.0)).collect()
}

fn idx(e: &mut Env, heir: &str, asset: Asset) -> u32 {
    e.plan().proposal.unwrap().transfers.iter().position(|t| t.heir.as_str() == heir && t.asset == asset).unwrap() as u32
}

#[test]
fn fixed_amount_is_paid_first_and_the_rest_split_by_share() {
    let mut e = ruled(rules(), 0);
    // tobi: 3 fixed + 40% of 7; amara: 60% of 7
    assert_eq!(near_of(&mut e), vec![("amara.testnet".into(), 42 * NEAR / 10), ("tobi.testnet".into(), 3 * NEAR + 28 * NEAR / 10)]);
}

#[test]
fn fixed_amount_is_capped_by_what_is_there() {
    let mut r = rules();
    r.fixed[0].amount = U128(50 * NEAR);
    let mut e = ruled(r, 0);
    assert_eq!(near_of(&mut e), vec![("tobi.testnet".into(), 10 * NEAR)]);
}

#[test]
fn remainder_goes_to_the_named_heir() {
    let mut r = rules();
    r.fixed[0].amount = U128(3 * NEAR + 1); // leaves 7 NEAR - 1: not divisible
    let mut e = ruled(r, 0);
    let n = near_of(&mut e);
    assert_eq!(n.iter().map(|x| x.1).sum::<u128>(), 10 * NEAR, "every yocto distributed");
    let left = 7 * NEAR - 1;
    assert_eq!(n[0].1, left - policy::share_of(left, 4000), "amara: share plus remainder");
}

#[test]
fn without_rules_rounding_remainder_stays() {
    let mut e = Env::new();
    e.as_("owner.testnet", NEAR).set_plan(plan_input());
    e.as_("owner.testnet", 10 * NEAR + 3).deposit(acc("owner.testnet"));
    e.advance(97 * DAY);
    e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), None, None, None);
    assert_eq!(e.plan().escrow.0, 1);
}

#[test]
fn zero_share_heir_receives_only_a_fixed_amount() {
    let mut e = Env::new();
    let mut p = plan_input();
    p.heirs[0].share_bps = 10_000;
    p.heirs[1].share_bps = 0;
    e.as_("owner.testnet", NEAR).set_plan(p);
    e.as_("owner.testnet", NEAR / 100).set_release_rules(Some(ReleaseRules { fixed: rules().fixed, ..Default::default() }));
    e.as_("owner.testnet", 10 * NEAR).deposit(acc("owner.testnet"));
    e.advance(97 * DAY);
    e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), None, None, None);
    assert_eq!(near_of(&mut e), vec![("amara.testnet".into(), 7 * NEAR), ("tobi.testnet".into(), 3 * NEAR)]);
}

#[test]
fn fixed_eth_comes_out_of_the_amount_after_the_fee_reserve() {
    let mut r = rules();
    r.fixed = vec![FixedAmount { heir: acc("amara.testnet"), asset: Asset::Eth, amount: U128(NEAR / 10) }];
    let mut e = ruled(r, NEAR);
    let i = idx(&mut e, "amara.testnet", Asset::Eth);
    let reserve = 21_000 * 50 * GWEI;
    let left = NEAR - reserve - NEAR / 10;
    // amara is the only ETH heir: fixed + 60% + the remainder (she is remainder_to);
    // tobi's 40% stays (no ETH destination)
    assert_eq!(e.plan().proposal.unwrap().transfers[i as usize].amount.0, NEAR / 10 + policy::share_of(left, 6000) + (left - policy::share_of(left, 6000) - policy::share_of(left, 4000)));
}

#[test]
fn unclaimed_share_goes_to_the_alternate_then_the_fallback() {
    let mut e = ruled(rules(), 0);
    let i = idx(&mut e, "amara.testnet", Asset::Near);
    e.advance(30 * DAY + WINDOW);
    e.as_("anyone.testnet", 0).reassign_unclaimed(acc("owner.testnet"), i);
    let t = e.plan().proposal.unwrap().transfers[i as usize].clone();
    assert_eq!((t.heir.as_str(), t.destination.as_str(), t.state), ("kemi.testnet", "kemi.testnet", TransferState::Pending));
    e.advance(WINDOW);
    e.as_("anyone.testnet", 0).reassign_unclaimed(acc("owner.testnet"), i);
    let t = e.plan().proposal.unwrap().transfers[i as usize].clone();
    assert_eq!((t.heir.as_str(), t.destination.as_str()), ("charity.testnet", "charity.testnet"));
    // the fallback, not a heir, can now claim it
    assert_eq!(e.as_("charity.testnet", 0).claim(acc("owner.testnet")), 1);
}

#[test]
fn alternate_can_claim_once_reassigned() {
    let mut e = ruled(rules(), 0);
    let i = idx(&mut e, "amara.testnet", Asset::Near);
    e.advance(30 * DAY + WINDOW);
    e.as_("x.testnet", 0).reassign_unclaimed(acc("owner.testnet"), i);
    assert_eq!(e.as_("kemi.testnet", 0).claim(acc("owner.testnet")), 1);
    assert_eq!(e.plan().proposal.unwrap().transfers[i as usize].state, TransferState::Sending);
}

#[test]
#[should_panic(expected = "E_NOT_REASSIGNABLE")]
fn cannot_reassign_before_the_claim_window_ends() {
    let mut e = ruled(rules(), 0);
    let i = idx(&mut e, "amara.testnet", Asset::Near);
    e.advance(30 * DAY + WINDOW - 1);
    e.as_("x.testnet", 0).reassign_unclaimed(acc("owner.testnet"), i);
}

#[test]
#[should_panic(expected = "E_NOT_REASSIGNABLE")]
fn claimed_transfers_are_never_reassigned() {
    let mut e = ruled(rules(), 0);
    let i = idx(&mut e, "amara.testnet", Asset::Near);
    e.advance(30 * DAY);
    let _ = e.as_("amara.testnet", 0).claim(acc("owner.testnet"));
    e.advance(WINDOW);
    e.as_("x.testnet", 0).reassign_unclaimed(acc("owner.testnet"), i);
}

#[test]
fn heir_without_alternate_goes_straight_to_the_fallback() {
    let mut e = ruled(rules(), 0);
    let i = idx(&mut e, "tobi.testnet", Asset::Near);
    e.advance(30 * DAY + WINDOW);
    e.as_("x.testnet", 0).reassign_unclaimed(acc("owner.testnet"), i);
    assert_eq!(e.plan().proposal.unwrap().transfers[i as usize].heir.as_str(), "charity.testnet");
}

#[test]
fn eth_share_skips_a_fallback_without_an_eth_address() {
    // amara's ETH: alternate kemi has an address, so it moves; from kemi the
    // fallback has none, so it stops there
    let mut e = ruled(rules(), NEAR);
    let i = idx(&mut e, "amara.testnet", Asset::Eth);
    e.advance(30 * DAY + WINDOW);
    e.as_("x.testnet", 0).reassign_unclaimed(acc("owner.testnet"), i);
    let t = e.plan().proposal.unwrap().transfers[i as usize].clone();
    assert_eq!((t.heir.as_str(), t.destination.as_str(), t.eth_tx.is_none()), ("kemi.testnet", "0x00000000000000000000000000000000000000bb", true));
    e.advance(WINDOW);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| e.as_("x.testnet", 0).reassign_unclaimed(acc("owner.testnet"), i)));
    assert!(r.is_err());
}

#[test]
#[should_panic(expected = "E_NOT_REASSIGNABLE")]
fn no_rules_means_nothing_is_reassigned() {
    let mut e = approved();
    e.advance(30 * DAY + 3 * 365 * DAY);
    e.as_("x.testnet", 0).reassign_unclaimed(acc("owner.testnet"), 0);
}

#[test]
#[should_panic(expected = "E_PROPOSAL_OPEN")]
fn rules_frozen_while_a_release_is_open() {
    let mut e = approved();
    e.as_("owner.testnet", NEAR / 100).set_release_rules(Some(rules()));
}

fn expect_bad_rules(mutate: impl FnOnce(&mut ReleaseRules)) {
    let mut r = rules();
    mutate(&mut r);
    let mut e = Env::new();
    e.as_("owner.testnet", NEAR).set_plan(plan_input());
    e.as_("owner.testnet", NEAR / 100).set_release_rules(Some(r));
}

#[test]
#[should_panic(expected = "E_INVALID_RULES")]
fn alternate_must_be_an_outsider() {
    expect_bad_rules(|r| r.alternates[0].recipient.account_id = acc("g1.testnet"));
}

#[test]
#[should_panic(expected = "E_INVALID_RULES")]
fn fixed_amount_needs_a_destination_on_that_chain() {
    expect_bad_rules(|r| r.fixed[0].asset = Asset::Eth); // tobi has no ETH address
}

#[test]
#[should_panic(expected = "E_INVALID_RULES")]
fn fallback_cannot_also_be_an_alternate() {
    expect_bad_rules(|r| r.fallback.as_mut().unwrap().account_id = acc("kemi.testnet"));
}

#[test]
#[should_panic(expected = "E_DURATION_OUT_OF_BOUNDS")]
fn claim_window_is_bounded() {
    expect_bad_rules(|r| r.claim_window_ms = DAY);
}

#[test]
#[should_panic(expected = "E_INVALID_RULES")]
fn changing_heirs_cannot_orphan_the_rules() {
    let mut e = Env::new();
    e.as_("owner.testnet", NEAR).set_plan(plan_input());
    e.as_("owner.testnet", NEAR / 100).set_release_rules(Some(rules()));
    let mut p = plan_input();
    p.heirs[1].account_id = acc("kemi.testnet"); // the alternate becomes a heir
    e.as_("owner.testnet", 0).set_plan(p);
}

#[test]
fn rules_can_be_cleared() {
    let mut e = Env::new();
    e.as_("owner.testnet", NEAR).set_plan(plan_input());
    e.as_("owner.testnet", NEAR / 100).set_release_rules(Some(rules()));
    assert!(e.as_("x.testnet", 0).get_release_rules(acc("owner.testnet")).is_some());
    e.as_("owner.testnet", 0).set_release_rules(None);
    assert!(e.as_("x.testnet", 0).get_release_rules(acc("owner.testnet")).is_none());
}

// ------------------------------------------------ release modes, delay signers

fn opts(mode: ReleaseMode) -> ReleaseOptions {
    ReleaseOptions {
        mode,
        hybrid_grace_ms: if mode == ReleaseMode::Hybrid { 7 * DAY } else { 0 },
        delay_signers: vec![acc("d1.testnet"), acc("d2.testnet"), acc("g1.testnet")],
        delay_quorum: 2,
        max_extension_ms: 14 * DAY,
        max_total_extension_ms: 30 * DAY,
        overrides: vec![],
    }
}

/// Funded plan with options `o`, approved (waiting ends 30 days later).
fn with_options(o: ReleaseOptions) -> Env {
    let mut e = Env::new();
    e.as_("owner.testnet", NEAR).set_plan(plan_input());
    e.as_("owner.testnet", NEAR / 100).set_release_options(Some(o));
    e.as_("owner.testnet", 10 * NEAR).deposit(acc("owner.testnet"));
    e.advance(97 * DAY);
    let id = e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), Some(U128(NEAR)), None, None);
    e.as_("g2.testnet", 0).approve_release(acc("owner.testnet"), id);
    e
}

fn states(e: &mut Env, heir: &str) -> Vec<TransferState> {
    e.plan().proposal.unwrap().transfers.iter().filter(|t| t.heir.as_str() == heir).map(|t| t.state).collect()
}

fn ends(e: &mut Env) -> u64 {
    e.plan().proposal.unwrap().waiting_ends_at_ms.unwrap()
}

#[test]
fn automatic_mode_lets_anyone_start_a_heirs_transfers_once_claimable() {
    let mut e = with_options(opts(ReleaseMode::Automatic));
    e.advance(30 * DAY);
    assert_eq!(e.as_("exec.testnet", 0).release(acc("owner.testnet"), acc("amara.testnet")), 2);
    assert_eq!(states(&mut e, "amara.testnet"), vec![TransferState::Sending, TransferState::Signing]);
    assert_eq!(states(&mut e, "tobi.testnet"), vec![TransferState::Pending], "only the named heir");
    // already started: a second call starts nothing
    assert_eq!(e.as_("x.testnet", 0).release(acc("owner.testnet"), acc("amara.testnet")), 0);
}

#[test]
#[should_panic(expected = "E_NOT_ELIGIBLE")]
fn automatic_release_still_waits_for_the_owner_window() {
    let mut e = with_options(opts(ReleaseMode::Automatic));
    e.advance(30 * DAY - 1);
    e.as_("exec.testnet", 0).release(acc("owner.testnet"), acc("amara.testnet"));
}

#[test]
#[should_panic(expected = "E_NOT_RELEASABLE")]
fn claim_mode_has_no_third_party_release() {
    let mut e = approved();
    e.advance(30 * DAY);
    e.as_("exec.testnet", 0).release(acc("owner.testnet"), acc("amara.testnet"));
}

#[test]
fn hybrid_mode_gives_heirs_a_grace_period_first() {
    let mut e = with_options(opts(ReleaseMode::Hybrid));
    e.advance(30 * DAY);
    let early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| e.as_("x.testnet", 0).release(acc("owner.testnet"), acc("tobi.testnet"))));
    assert!(early.is_err(), "not during the grace period");
    let _ = e.as_("amara.testnet", 0).claim(acc("owner.testnet")); // heirs can always claim
    e.advance(7 * DAY);
    assert_eq!(e.as_("x.testnet", 0).release(acc("owner.testnet"), acc("tobi.testnet")), 1);
}

#[test]
fn delay_signers_extend_the_waiting_period_and_the_owner_can_still_cancel() {
    let mut e = with_options(opts(ReleaseMode::Claim));
    let id = e.plan().proposal.unwrap().id;
    let end = ends(&mut e);
    e.as_("d1.testnet", 0).request_extension(acc("owner.testnet"), id, 10 * DAY, Some("owner-in-hospital".into()));
    assert_eq!(ends(&mut e), end, "one vote is not quorum");
    e.as_("g1.testnet", 0).approve_extension(acc("owner.testnet"), id);
    assert_eq!(ends(&mut e), end + 10 * DAY);
    let x = e.as_("x.testnet", 0).get_extension(acc("owner.testnet")).unwrap();
    assert_eq!((x.total_ms, x.count, x.pending), (10 * DAY, 1, None));
    // past the original end the owner can still cancel; heirs can't claim
    e.advance(35 * DAY);
    assert_eq!(e.status(), PlanStatus::Waiting);
    e.as_("owner.testnet", 0).cancel_release();
    assert!(e.plan().proposal.is_none());
}

#[test]
#[should_panic(expected = "E_NOT_ELIGIBLE")]
fn heirs_cannot_claim_during_an_extension() {
    let mut e = with_options(opts(ReleaseMode::Claim));
    let id = e.plan().proposal.unwrap().id;
    e.as_("d1.testnet", 0).request_extension(acc("owner.testnet"), id, 10 * DAY, None);
    e.as_("d2.testnet", 0).approve_extension(acc("owner.testnet"), id);
    e.advance(35 * DAY);
    e.as_("amara.testnet", 0).claim(acc("owner.testnet"));
}

#[test]
#[should_panic(expected = "E_EXTENSION_TOO_LONG")]
fn one_extension_is_capped() {
    let mut e = with_options(opts(ReleaseMode::Claim));
    let id = e.plan().proposal.unwrap().id;
    e.as_("d1.testnet", 0).request_extension(acc("owner.testnet"), id, 14 * DAY + 1, None);
}

#[test]
#[should_panic(expected = "E_EXTENSION_TOO_LONG")]
fn total_extension_is_capped() {
    let mut e = with_options(opts(ReleaseMode::Claim));
    let id = e.plan().proposal.unwrap().id;
    for _ in 0..2 {
        e.as_("d1.testnet", 0).request_extension(acc("owner.testnet"), id, 14 * DAY, None);
        e.as_("d2.testnet", 0).approve_extension(acc("owner.testnet"), id);
    }
    e.as_("d1.testnet", 0).request_extension(acc("owner.testnet"), id, 2 * DAY + 1, None); // 28 + 2d+1 > 30
}

#[test]
#[should_panic(expected = "E_NOT_DELAY_SIGNER")]
fn only_delay_signers_extend() {
    let mut e = with_options(opts(ReleaseMode::Claim));
    let id = e.plan().proposal.unwrap().id;
    e.as_("g2.testnet", 0).request_extension(acc("owner.testnet"), id, DAY, None);
}

#[test]
#[should_panic(expected = "E_EXTENSION_PENDING")]
fn one_extension_request_at_a_time() {
    let mut e = with_options(opts(ReleaseMode::Claim));
    let id = e.plan().proposal.unwrap().id;
    e.as_("d1.testnet", 0).request_extension(acc("owner.testnet"), id, DAY, None);
    e.as_("d2.testnet", 0).request_extension(acc("owner.testnet"), id, 2 * DAY, None);
}

#[test]
#[should_panic(expected = "E_ALREADY_VOTED")]
fn a_signer_votes_once() {
    let mut e = with_options(opts(ReleaseMode::Claim));
    let id = e.plan().proposal.unwrap().id;
    e.as_("d1.testnet", 0).request_extension(acc("owner.testnet"), id, DAY, None);
    e.as_("d1.testnet", 0).approve_extension(acc("owner.testnet"), id);
}

#[test]
#[should_panic(expected = "E_NOT_ELIGIBLE")]
fn no_extension_after_the_waiting_period_ends() {
    let mut e = with_options(opts(ReleaseMode::Claim));
    let id = e.plan().proposal.unwrap().id;
    e.advance(30 * DAY);
    e.as_("d1.testnet", 0).request_extension(acc("owner.testnet"), id, DAY, None);
}

#[test]
#[should_panic(expected = "E_NOT_ELIGIBLE")]
fn no_extension_before_approval() {
    let mut e = Env::new();
    e.as_("owner.testnet", NEAR).set_plan(plan_input());
    e.as_("owner.testnet", NEAR / 100).set_release_options(Some(opts(ReleaseMode::Claim)));
    e.as_("owner.testnet", 10 * NEAR).deposit(acc("owner.testnet"));
    e.advance(97 * DAY);
    let id = e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), None, None, None);
    e.as_("d1.testnet", 0).request_extension(acc("owner.testnet"), id, DAY, None);
}

#[test]
fn extension_state_does_not_carry_into_a_new_proposal() {
    let mut e = with_options(opts(ReleaseMode::Claim));
    let id = e.plan().proposal.unwrap().id;
    e.as_("d1.testnet", 0).request_extension(acc("owner.testnet"), id, DAY, None);
    e.as_("owner.testnet", 0).cancel_release();
    e.advance(97 * DAY);
    let id2 = e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), None, None, None);
    assert!(e.as_("x.testnet", 0).get_extension(acc("owner.testnet")).is_none());
    e.as_("g2.testnet", 0).approve_release(acc("owner.testnet"), id2);
    e.as_("d2.testnet", 0).request_extension(acc("owner.testnet"), id2, DAY, None); // not blocked by the old request
}

fn expect_bad_options(mutate: impl FnOnce(&mut ReleaseOptions)) {
    let mut o = opts(ReleaseMode::Hybrid);
    mutate(&mut o);
    let mut e = Env::new();
    e.as_("owner.testnet", NEAR).set_plan(plan_input());
    e.as_("owner.testnet", NEAR / 100).set_release_options(Some(o));
}

#[test]
#[should_panic(expected = "E_INVALID_OPTIONS")]
fn heir_cannot_be_a_delay_signer() {
    expect_bad_options(|o| o.delay_signers[0] = acc("amara.testnet"));
}

#[test]
#[should_panic(expected = "E_INVALID_QUORUM")]
fn delay_quorum_within_signers() {
    expect_bad_options(|o| o.delay_quorum = 4);
}

#[test]
#[should_panic(expected = "E_DURATION_OUT_OF_BOUNDS")]
fn total_cap_at_least_one_extension() {
    expect_bad_options(|o| o.max_total_extension_ms = DAY);
}

#[test]
#[should_panic(expected = "E_DURATION_OUT_OF_BOUNDS")]
fn hybrid_grace_is_bounded() {
    expect_bad_options(|o| o.hybrid_grace_ms = 1);
}

#[test]
#[should_panic(expected = "E_PROPOSAL_OPEN")]
fn options_frozen_while_a_release_is_open() {
    let mut e = approved();
    e.as_("owner.testnet", NEAR / 100).set_release_options(Some(opts(ReleaseMode::Automatic)));
}

#[test]
#[should_panic(expected = "E_INVALID_OPTIONS")]
fn making_a_delay_signer_a_heir_is_refused() {
    let mut e = Env::new();
    e.as_("owner.testnet", NEAR).set_plan(plan_input());
    e.as_("owner.testnet", NEAR / 100).set_release_options(Some(opts(ReleaseMode::Claim)));
    let mut p = plan_input();
    p.heirs[1].account_id = acc("d1.testnet");
    e.as_("owner.testnet", 0).set_plan(p);
}

fn ov(heir: Option<&str>, assets: AssetGroup, mode: ReleaseMode, grace: u64) -> ModeOverride {
    ModeOverride { heir: heir.map(acc), assets, mode, hybrid_grace_ms: grace }
}

#[test]
fn per_heir_mode_overrides_the_plan_mode() {
    // plan: Claim; Tobi alone is Automatic
    let mut o = opts(ReleaseMode::Claim);
    o.overrides = vec![ov(Some("tobi.testnet"), AssetGroup::All, ReleaseMode::Automatic, 0)];
    let mut e = with_options(o);
    e.advance(30 * DAY);
    assert_eq!(e.as_("exec.testnet", 0).release(acc("owner.testnet"), acc("tobi.testnet")), 1);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| e.as_("exec.testnet", 0).release(acc("owner.testnet"), acc("amara.testnet"))));
    assert!(r.is_err(), "Amara keeps the plan's Claim mode");
}

#[test]
fn per_asset_group_mode_releases_only_that_group() {
    // NEAR side automatic for everyone; Ethereum side stays Claim
    let mut o = opts(ReleaseMode::Claim);
    o.overrides = vec![ov(None, AssetGroup::Near, ReleaseMode::Automatic, 0)];
    let mut e = with_options(o);
    e.advance(30 * DAY);
    assert_eq!(e.as_("exec.testnet", 0).release(acc("owner.testnet"), acc("amara.testnet")), 1);
    assert_eq!(states(&mut e, "amara.testnet"), vec![TransferState::Sending, TransferState::Pending], "NEAR started, ETH waits for her claim");
    assert_eq!(e.as_("amara.testnet", 0).claim(acc("owner.testnet")), 1);
}

#[test]
fn first_matching_override_wins() {
    // Amara's Ethereum side is Hybrid (7 days) though every Ethereum share is Automatic
    let mut o = opts(ReleaseMode::Claim);
    o.overrides = vec![
        ov(Some("amara.testnet"), AssetGroup::Ethereum, ReleaseMode::Hybrid, 7 * DAY),
        ov(None, AssetGroup::Ethereum, ReleaseMode::Automatic, 0),
    ];
    let mut e = with_options(o);
    e.advance(30 * DAY);
    let early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| e.as_("x.testnet", 0).release(acc("owner.testnet"), acc("amara.testnet"))));
    assert!(early.is_err());
    e.advance(7 * DAY);
    assert_eq!(e.as_("x.testnet", 0).release(acc("owner.testnet"), acc("amara.testnet")), 1);
    assert_eq!(states(&mut e, "amara.testnet"), vec![TransferState::Pending, TransferState::Signing]);
}

#[test]
#[should_panic(expected = "E_INVALID_OPTIONS")]
fn override_must_name_a_heir() {
    expect_bad_options(|o| o.overrides = vec![ov(Some("kemi.testnet"), AssetGroup::All, ReleaseMode::Automatic, 0)]);
}

#[test]
#[should_panic(expected = "E_DURATION_OUT_OF_BOUNDS")]
fn override_hybrid_grace_is_bounded() {
    expect_bad_options(|o| o.overrides = vec![ov(None, AssetGroup::Near, ReleaseMode::Hybrid, 1)]);
}

#[test]
fn options_stored_before_overrides_still_read() {
    let mut e = Env::new();
    e.as_("owner.testnet", NEAR).set_plan(plan_input());
    let v1 = ReleaseOptionsV1 { mode: ReleaseMode::Automatic, hybrid_grace_ms: 0, delay_signers: vec![], delay_quorum: 0, max_extension_ms: 0, max_total_extension_ms: 0 };
    env::storage_write(b"opts:owner.testnet", &near_sdk::borsh::to_vec(&v1).unwrap());
    let o = e.as_("x.testnet", 0).get_release_options(acc("owner.testnet")).unwrap();
    assert_eq!((o.mode, o.overrides.len()), (ReleaseMode::Automatic, 0));
}

// ------------------------------------------------------------------ bitcoin
// Vector generated with @scure/btc-signer 2.4.1 (key 0x01…01, see git log).

mod btc_vectors {
    use crate::btc::*;

    fn h(s: &str) -> Vec<u8> {
        crate::eth::hex_decode(s).unwrap()
    }
    fn h32(s: &str) -> [u8; 32] {
        h(s).try_into().unwrap()
    }
    const PUB: &str = "031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f";
    const PKH: &str = "79b000887626b294a914501a4cd226b58b235983";
    const TAPROOT: &str = "tb1p5e6v9v2j5wp3y6c79gaqdqltq7jdv45fswnnm7exmmp2020mqepsvssqqw";

    fn tx() -> Tx {
        Tx {
            inputs: vec![
                Input { txid: h32(&format!("{}01", "aa".repeat(31))), vout: 1, value: 50_000 },
                Input { txid: h32(&format!("{}02", "bb".repeat(31))), vout: 0, value: 7_000 },
            ],
            outputs: vec![
                Output { script: address_script(TAPROOT).unwrap(), value: 30_000 },
                Output { script: p2wpkh_script(&h(PKH).try_into().unwrap()), value: 26_500 },
            ],
        }
    }

    /// (r, s) out of a DER signature + sighash byte.
    fn rs(der: &str) -> ([u8; 32], [u8; 32]) {
        let d = h(der);
        let rl = d[3] as usize;
        let r = &d[4..4 + rl];
        let sl = d[5 + rl] as usize;
        let s = &d[6 + rl..6 + rl + sl];
        let pad = |x: &[u8]| {
            let x = if x.len() == 33 { &x[1..] } else { x };
            let mut o = [0u8; 32];
            o[32 - x.len()..].copy_from_slice(x);
            o
        };
        (pad(r), pad(s))
    }

    const SIG0: &str = "3045022100de7b249a9c6f0ff4c393c141f1973d27f744342dc0424744090630bf049b28df022002adb29b7835521958c4cf38887c3a9697d0c443fc2c8a29085c45c47298c59201";
    const SIG1: &str = "304402204dd745d8487314c4f167ab80db61decf731ba2d07c5e161bcb97efb66de38c010220385c31daf6be3642669ecc2cf51db492514d8683ffc0ec55e461cb5795f4469601";

    #[test]
    fn addresses_decode_and_encode() {
        assert_eq!(address_script(TAPROOT).unwrap(), h("5120a674c2b152a383126b1e2a3a0683eb07a4d6568983a73dfb26dec2a7a9fb0643"));
        assert_eq!(address_script("tb1q0xcqpzrky6eff2g52qdye53xkk9jxkvraulyla").unwrap(), h(&format!("0014{PKH}")));
        assert_eq!(p2wpkh_address(&h(PKH).try_into().unwrap()), "tb1q0xcqpzrky6eff2g52qdye53xkk9jxkvraulyla");
        assert_eq!(hash160(&h(PUB)), h32(&format!("{PKH}{}", "00".repeat(12)))[..20]);
    }

    #[test]
    fn bad_addresses_are_refused() {
        for a in [
            "tb1q0xcqpzrky6eff2g52qdye53xkk9jxkvraulylb",                             // checksum
            "bc1q0xcqpzrky6eff2g52qdye53xkk9jxkvraulyla",                             // mainnet
            "TB1Q0XCQPZRKY6EFF2G52QDYE53XKK9JXKVRAULYLA",                             // uppercase
            "tb1p5e6v9v2j5wp3y6c79gaqdqltq7jdv45fswnnm7exmmp2020mqepsvssqqx",         // bech32m checksum
            "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn",                                     // legacy
        ] {
            assert!(address_script(a).is_none(), "{a}");
        }
    }

    #[test]
    fn sighashes_txid_and_signed_tx_match_scure() {
        let t = tx();
        let pkh: [u8; 20] = h(PKH).try_into().unwrap();
        assert_eq!(crate::eth::hex_encode(&t.sighash(0, &pkh)), "43e76f3eab784e81a73c2bc2f85ebd2a0384dd00e41245a6cff5ebcdc75094bd");
        assert_eq!(crate::eth::hex_encode(&t.sighash(1, &pkh)), "162d5c0bb501ec3bdd9375e478dfec5797766fa65fa274949ec123eee72e55d5");
        assert_eq!(crate::eth::hex_encode(&t.txid()), "e862c0219ad42586e7f815d5bf3beb6639b60b4235ae20fdb2f5a0cf3bb64af6");
        let sigs: Vec<Vec<u8>> = [SIG0, SIG1].iter().map(|s| {
            let (r, s) = rs(s);
            der_sig(&r, &s)
        }).collect();
        assert_eq!(sigs[0], h(SIG0));
        assert_eq!(sigs[1], h(SIG1));
        let raw = t.signed(&h(PUB).try_into().unwrap(), &sigs);
        assert_eq!(crate::eth::hex_encode(&raw), "0200000000010201aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0100000000fdffffff02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb0000000000fdffffff023075000000000000225120a674c2b152a383126b1e2a3a0683eb07a4d6568983a73dfb26dec2a7a9fb0643846700000000000016001479b000887626b294a914501a4cd226b58b23598302483045022100de7b249a9c6f0ff4c393c141f1973d27f744342dc0424744090630bf049b28df022002adb29b7835521958c4cf38887c3a9697d0c443fc2c8a29085c45c47298c5920121031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f0247304402204dd745d8487314c4f167ab80db61decf731ba2d07c5e161bcb97efb66de38c010220385c31daf6be3642669ecc2cf51db492514d8683ffc0ec55e461cb5795f446960121031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f00000000");
    }

    #[test]
    fn high_s_is_normalized() {
        // n - s gives the same (low-S) DER
        const N: &str = "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141";
        let (r, s) = rs(SIG0);
        let n = h32(N);
        let mut hi = [0u8; 32];
        let mut borrow = 0i16;
        for i in (0..32).rev() {
            let mut d = n[i] as i16 - s[i] as i16 - borrow;
            borrow = (d < 0) as i16;
            if d < 0 {
                d += 256;
            }
            hi[i] = d as u8;
        }
        assert_eq!(der_sig(&r, &hi), h(SIG0));
    }

    #[test]
    fn vsize_estimate_covers_the_real_size() {
        let est = vsize(2, &[34, 22]);
        assert!((221..=223).contains(&est), "{est}");
    }

    #[test]
    fn compress_uses_y_parity() {
        let mut xy = [0u8; 64];
        xy[0] = 7;
        xy[63] = 3;
        assert_eq!(compress(&xy).unwrap()[0], 3);
        xy[63] = 4;
        assert_eq!(compress(&xy).unwrap()[..2], [2, 7]);
    }
}

// -------------------------------------------------------------- bitcoin flow

mod btc_flow {
    use super::*;

    /// MPC `derived_public_key` answer for private key 0x01…01 (see btc_vectors).
    const MPC_KEY: &str = "secp256k1:Yupq21BV61j6SMaWtDW5wtnq48cnFVcJQk4h3Nh4qNH2GBzqasSkjTTTMuRsjMKVKpYd6ECNHYx7DLoGtK8tgic";
    const VAULT: &str = "tb1q0xcqpzrky6eff2g52qdye53xkk9jxkvraulyla";
    const AMARA_BTC: &str = "tb1p5e6v9v2j5wp3y6c79gaqdqltq7jdv45fswnnm7exmmp2020mqepsvssqqw";
    const TOBI_BTC: &str = "tb1q0xcqpzrky6eff2g52qdye53xkk9jxkvraulyla";
    const COIN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01";

    fn utxo(txid: &str, vout: u32, value: u64) -> BtcUtxo {
        BtcUtxo { txid: txid.into(), vout, value: U64(value) }
    }

    fn o() -> AccountId {
        acc("owner.testnet")
    }

    fn with_vault() -> Env {
        let mut e = Env::new();
        e.as_("owner.testnet", NEAR).set_plan(plan_input());
        let _ = e.as_("anyone.testnet", 0).register_btc_vault(o());
        let key = format!("\"{MPC_KEY}\"");
        assert!(e.callback(vec![PromiseResult::Successful(key.into_bytes())]).on_btc_vault_key(o()));
        e.as_("owner.testnet", NEAR / 10).set_btc_destinations(vec![
            BtcDestination { account_id: acc("amara.testnet"), address: AMARA_BTC.into() },
            BtcDestination { account_id: acc("tobi.testnet"), address: TOBI_BTC.into() },
        ]);
        e.as_("owner.testnet", 10 * NEAR).deposit(o());
        e
    }

    fn proposed(e: &mut Env, utxos: Vec<BtcUtxo>) -> u64 {
        e.advance(97 * DAY);
        let id = e.as_("g1.testnet", 0).propose_release(o(), None, None, Some(utxos));
        e.as_("g2.testnet", 0).approve_release(o(), id);
        id
    }

    fn btc_idx(e: &mut Env, heir: &str) -> u32 {
        e.plan().proposal.unwrap().transfers.iter().position(|t| t.asset == Asset::Btc && t.heir == acc(heir)).unwrap() as u32
    }

    fn sign(e: &mut Env, idx: u32, n: usize) {
        let attempt = e.plan().proposal.unwrap().transfers[idx as usize].attempts;
        e.callback((0..n).map(|_| mpc_ok(BIG_R, S, 0)).collect()).on_btc_signed(o(), idx, attempt);
    }

    #[test]
    fn vault_key_and_address() {
        let mut e = with_vault();
        let v = e.as_("x.testnet", 0).get_btc_vault(o()).unwrap();
        assert_eq!(v.address, VAULT);
        assert_eq!(v.path, "behest/v1/owner.testnet/btc");
        assert_eq!(v.pubkey, "031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f");
    }

    #[test]
    #[should_panic(expected = "E_INVALID_BTC_ADDRESS")]
    fn mainnet_destination_refused() {
        let mut e = with_vault();
        e.as_("owner.testnet", NEAR / 10).set_btc_destinations(vec![BtcDestination { account_id: acc("amara.testnet"), address: "bc1q0xcqpzrky6eff2g52qdye53xkk9jxkvraulyla".into() }]);
    }

    #[test]
    #[should_panic(expected = "E_INVALID_HEIRS")]
    fn destination_for_stranger_refused() {
        let mut e = with_vault();
        e.as_("owner.testnet", NEAR / 10).set_btc_destinations(vec![BtcDestination { account_id: acc("mallory.testnet"), address: "tb1p5e6v9v2j5wp3y6c79gaqdqltq7jdv45fswnnm7exmmp2020mqepsvssqqw".into() }]);
    }

    #[test]
    #[should_panic(expected = "E_BTC_VAULT_UNKNOWN")]
    fn proposal_with_coins_needs_registered_vault() {
        let mut e = Env::new();
        e.as_("owner.testnet", NEAR).set_plan(plan_input());
        e.as_("owner.testnet", NEAR / 10).set_btc_destinations(vec![BtcDestination { account_id: acc("amara.testnet"), address: "tb1p5e6v9v2j5wp3y6c79gaqdqltq7jdv45fswnnm7exmmp2020mqepsvssqqw".into() }]);
        e.advance(97 * DAY);
        e.as_("g1.testnet", 0).propose_release(o(), None, None, Some(vec![utxo(COIN, 0, 100_000)]));
    }

    #[test]
    #[should_panic(expected = "E_INVALID_UTXOS")]
    fn duplicate_coins_refused() {
        let mut e = with_vault();
        proposed(&mut e, vec![utxo(COIN, 0, 100_000), utxo(COIN, 0, 100_000)]);
    }

    #[test]
    fn split_reserves_fees_and_chains_payouts() {
        let mut e = with_vault();
        let id = proposed(&mut e, vec![utxo(COIN, 1, 100_000)]);
        let rel = e.as_("x.testnet", 0).get_btc_release(o()).unwrap();
        // two payouts at the 5 sat/vB cap: 153 vB each
        assert_eq!(rel.reserve.0, 1_530);
        let (a, t) = (btc_idx(&mut e, "amara.testnet"), btc_idx(&mut e, "tobi.testnet"));
        let tr = e.plan().proposal.unwrap().transfers;
        assert_eq!((tr[a as usize].amount.0, tr[t as usize].amount.0), (59_082, 39_388));
        assert_eq!(tr[a as usize].destination, AMARA_BTC);

        e.advance(30 * DAY);
        let _ = e.as_("amara.testnet", 0).claim(o());
        let receipts = near_sdk::test_utils::get_created_receipts();
        let ta = e.as_("x.testnet", 0).get_btc_tx(o(), a).unwrap();
        assert_eq!(ta.inputs, vec![utxo(COIN, 1, 100_000)]);
        assert_eq!(ta.outputs[0].value.0, 59_082);
        assert_eq!(ta.fee.0, 306);
        assert_eq!(ta.outputs[1].value.0, 100_000 - 59_082 - 306);
        // the MPC is asked for exactly the BIP143 digest, on the vault path
        let mpc = receipts.iter().find(|r| r.receiver_id == acc("v1.signer-prod.testnet")).expect("MPC receipt");
        if let near_sdk::mock::MockAction::FunctionCallWeight { args, .. } = &mpc.actions[0] {
            let a = String::from_utf8(args.clone()).unwrap();
            assert!(a.contains(&ta.sighashes[0]) && a.contains("behest/v1/owner.testnet/btc"), "{a}");
        }
        let rel = e.as_("x.testnet", 0).get_btc_release(o()).unwrap();
        assert_eq!((rel.signed, rel.last), (1, Some(a)));
        assert_eq!(rel.head, vec![utxo(&ta.txid, 1, 40_612)]);

        sign(&mut e, a, 1);
        let ta = e.as_("x.testnet", 0).get_btc_tx(o(), a).unwrap();
        let raw = ta.raw.clone().unwrap();
        assert!(raw.starts_with("020000000001") && raw.ends_with("00000000"));
        assert_eq!(e.plan().proposal.unwrap().transfers[a as usize].state, TransferState::Signed);

        // Tobi's payout spends Amara's change
        let _ = e.as_("tobi.testnet", 0).claim(o());
        let tt = e.as_("x.testnet", 0).get_btc_tx(o(), t).unwrap();
        assert_eq!(tt.inputs, vec![utxo(&ta.txid, 1, 40_612)]);
        assert_eq!(tt.seq, 1);
        assert_eq!(tt.outputs[0].value.0, 39_388);
        assert_eq!(tt.outputs[1].value.0, 40_612 - 39_388 - 282); // P2WPKH heir: 141 vB
        let _ = id;
    }

    #[test]
    fn only_the_latest_payout_can_be_fee_bumped() {
        let mut e = with_vault();
        proposed(&mut e, vec![utxo(COIN, 1, 100_000)]);
        e.as_("admin.testnet", 0).add_executor(acc("exec.testnet"));
        let (a, t) = (btc_idx(&mut e, "amara.testnet"), btc_idx(&mut e, "tobi.testnet"));
        e.advance(30 * DAY);
        let _ = e.as_("amara.testnet", 0).claim(o());
        sign(&mut e, a, 1);
        let _ = e.as_("tobi.testnet", 0).claim(o());
        sign(&mut e, t, 1);
        let before = e.as_("x.testnet", 0).get_btc_tx(o(), t).unwrap();
        e.as_("exec.testnet", 0).report_failed(o(), t, "Dropped".into());
        let _ = e.as_("exec.testnet", 0).retry_transfer(o(), t);
        let after = e.as_("x.testnet", 0).get_btc_tx(o(), t).unwrap();
        assert_eq!(after.inputs, before.inputs);
        assert_eq!(after.outputs[0], before.outputs[0]);
        assert_eq!(after.fee_rate, 3);
        assert!(after.outputs[1].value.0 < before.outputs[1].value.0);

        e.as_("exec.testnet", 0).report_failed(o(), a, "Dropped".into());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = e.as_("exec.testnet", 0).retry_transfer(o(), a);
        }));
        assert!(r.is_err());
    }

    #[test]
    fn signing_failure_resigns_the_same_tx() {
        let mut e = with_vault();
        proposed(&mut e, vec![utxo(COIN, 1, 100_000)]);
        let a = btc_idx(&mut e, "amara.testnet");
        e.advance(30 * DAY);
        let _ = e.as_("amara.testnet", 0).claim(o());
        let first = e.as_("x.testnet", 0).get_btc_tx(o(), a).unwrap().txid;
        e.callback(vec![PromiseResult::Failed]).on_btc_signed(o(), a, 1);
        assert_eq!(e.plan().proposal.unwrap().transfers[a as usize].state, TransferState::Failed);
        let _ = e.as_("amara.testnet", 0).retry_transfer(o(), a);
        let again = e.as_("x.testnet", 0).get_btc_tx(o(), a).unwrap();
        assert_eq!(again.txid, first);
        assert_eq!(e.as_("x.testnet", 0).get_btc_release(o()).unwrap().signed, 1);
    }

    #[test]
    fn guardian_rebase_replaces_unsent_payouts() {
        let mut e = with_vault();
        proposed(&mut e, vec![utxo(COIN, 1, 100_000)]);
        let a = btc_idx(&mut e, "amara.testnet");
        e.advance(30 * DAY);
        let _ = e.as_("amara.testnet", 0).claim(o());
        sign(&mut e, a, 1);
        // the reported coin had a sibling: rebase must keep an old coin
        let other = "bb".repeat(32);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            e.as_("g1.testnet", 0).rebase_btc(o(), vec![utxo(&other, 0, 200_000)]);
        }));
        assert!(r.is_err());
        e.as_("g1.testnet", 0).rebase_btc(o(), vec![utxo(COIN, 1, 100_000), utxo(&other, 0, 5_000)]);
        assert_eq!(e.plan().proposal.unwrap().transfers[a as usize].state, TransferState::Pending);
        assert!(e.as_("x.testnet", 0).get_btc_tx(o(), a).is_none());
        let _ = e.as_("amara.testnet", 0).claim(o());
        assert_eq!(e.as_("x.testnet", 0).get_btc_tx(o(), a).unwrap().inputs.len(), 2);
    }

    #[test]
    #[should_panic(expected = "E_INVALID_TRANSFER_STATE")]
    fn rebase_refused_after_broadcast() {
        let mut e = with_vault();
        proposed(&mut e, vec![utxo(COIN, 1, 100_000)]);
        e.as_("admin.testnet", 0).add_executor(acc("exec.testnet"));
        let a = btc_idx(&mut e, "amara.testnet");
        e.advance(30 * DAY);
        let _ = e.as_("amara.testnet", 0).claim(o());
        sign(&mut e, a, 1);
        let txid = e.as_("x.testnet", 0).get_btc_tx(o(), a).unwrap().txid;
        e.as_("exec.testnet", 0).report_broadcast(o(), a, txid);
        e.as_("g1.testnet", 0).rebase_btc(o(), vec![utxo(COIN, 1, 100_000)]);
    }

    #[test]
    fn btc_settles_with_the_plan() {
        let mut e = with_vault();
        proposed(&mut e, vec![utxo(COIN, 1, 100_000)]);
        e.as_("admin.testnet", 0).add_executor(acc("exec.testnet"));
        e.advance(30 * DAY);
        let _ = e.as_("amara.testnet", 0).claim(o());
        let _ = e.as_("tobi.testnet", 0).claim(o());
        let p = e.plan().proposal.unwrap();
        for (i, t) in p.transfers.iter().enumerate() {
            if t.asset.is_btc() {
                sign(&mut e, i as u32, 1);
                let txid = e.as_("x.testnet", 0).get_btc_tx(o(), i as u32).unwrap().txid;
                e.as_("exec.testnet", 0).report_broadcast(o(), i as u32, txid.clone());
                e.as_("exec.testnet", 0).report_confirmed(o(), i as u32, txid);
            }
        }
        let p = e.plan().proposal.unwrap();
        assert!(p.transfers.iter().filter(|t| t.asset.is_btc()).all(|t| t.state == TransferState::Confirmed));
    }

    #[test]
    fn owner_withdraws_btc_with_change_to_vault() {
        let mut e = with_vault();
        let _ = e.as_("owner.testnet", 0).withdraw_btc(vec![utxo(COIN, 1, 100_000)], U64(20_000), AMARA_BTC.into());
        let w = e.as_("x.testnet", 0).get_btc_tx(o(), VAULT_WITHDRAWAL).unwrap();
        assert_eq!(w.outputs[0].value.0, 20_000);
        assert_eq!(w.outputs[1].script, "001479b000887626b294a914501a4cd226b58b235983");
        e.callback(vec![mpc_ok(BIG_R, S, 0)]).on_btc_signed(o(), VAULT_WITHDRAWAL, 1);
        assert!(e.as_("x.testnet", 0).get_btc_tx(o(), VAULT_WITHDRAWAL).unwrap().raw.is_some());
    }

    #[test]
    fn bumped_withdrawal_keeps_the_original_and_adopts_it() {
        let mut e = with_vault();
        e.as_("admin.testnet", 0).add_executor(acc("exec.testnet"));
        let w = VAULT_WITHDRAWAL;
        let _ = e.as_("owner.testnet", 0).withdraw_btc(vec![utxo(COIN, 1, 100_000)], U64(20_000), AMARA_BTC.into());
        e.callback(vec![mpc_ok(BIG_R, S, 0)]).on_btc_signed(o(), w, 1);
        let first = e.as_("x.testnet", 0).get_btc_tx(o(), w).unwrap();
        e.as_("exec.testnet", 0).report_broadcast(o(), w, first.txid.clone());
        e.as_("exec.testnet", 0).report_failed(o(), w, "Stuck".into());
        let _ = e.as_("exec.testnet", 0).retry_transfer(o(), w);
        e.callback(vec![mpc_ok(BIG_R, S, 0)]).on_btc_signed(o(), w, 2);
        let bumped = e.as_("x.testnet", 0).get_btc_tx(o(), w).unwrap();
        assert_ne!(bumped.txid, first.txid);
        let v = e.as_("x.testnet", 0).get_btc_tx_versions(o(), w);
        assert_eq!(v.iter().map(|x| x.txid.clone()).collect::<Vec<_>>(), vec![first.txid.clone()]);

        // the original may still be mined, so the withdrawal can't be cancelled
        e.as_("exec.testnet", 0).report_failed(o(), w, "Conflict".into());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = e.as_("exec.testnet", 0).cancel_vault_withdrawal(o());
        }));
        assert!(r.is_err());
        // a txid the contract never built is refused
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            e.as_("exec.testnet", 0).report_broadcast(o(), w, "ff".repeat(32));
        }));
        assert!(r.is_err());

        // the network mined the original: it becomes current again
        e.as_("exec.testnet", 0).report_broadcast(o(), w, first.txid.clone());
        let cur = e.as_("x.testnet", 0).get_btc_tx(o(), w).unwrap();
        assert_eq!((cur.txid.clone(), cur.fee_rate), (first.txid.clone(), 2));
        assert_eq!(e.as_("x.testnet", 0).get_btc_tx_versions(o(), w)[0].txid, bumped.txid);
        e.as_("exec.testnet", 0).report_confirmed(o(), w, first.txid.clone());
        assert_eq!(e.as_("x.testnet", 0).get_vault_withdrawal(o()).unwrap().state, TransferState::Confirmed);
    }

    #[test]
    fn a_payout_reported_stuck_that_gets_mined_is_tracked_again() {
        // testnet4 mined only empty blocks for hours, then took the payout
        let mut e = with_vault();
        e.as_("admin.testnet", 0).add_executor(acc("exec.testnet"));
        let w = VAULT_WITHDRAWAL;
        let _ = e.as_("owner.testnet", 0).withdraw_btc(vec![utxo(COIN, 1, 100_000)], U64(20_000), AMARA_BTC.into());
        e.callback(vec![mpc_ok(BIG_R, S, 0)]).on_btc_signed(o(), w, 1);
        let tx = e.as_("x.testnet", 0).get_btc_tx(o(), w).unwrap();
        e.as_("exec.testnet", 0).report_broadcast(o(), w, tx.txid.clone());
        e.as_("exec.testnet", 0).report_failed(o(), w, "Stuck".into());
        e.as_("exec.testnet", 0).report_broadcast(o(), w, tx.txid.clone());
        let t = e.as_("x.testnet", 0).get_vault_withdrawal(o()).unwrap();
        assert_eq!((t.state, t.failure), (TransferState::Broadcast, None));
        e.as_("exec.testnet", 0).report_confirmed(o(), w, tx.txid);
        assert_eq!(e.as_("x.testnet", 0).get_vault_withdrawal(o()).unwrap().state, TransferState::Confirmed);
    }

    #[test]
    fn adopting_an_earlier_head_rechains_later_payouts() {
        let mut e = with_vault();
        proposed(&mut e, vec![utxo(COIN, 1, 100_000)]);
        e.as_("admin.testnet", 0).add_executor(acc("exec.testnet"));
        let (a, t) = (btc_idx(&mut e, "amara.testnet"), btc_idx(&mut e, "tobi.testnet"));
        e.advance(30 * DAY);
        let _ = e.as_("amara.testnet", 0).claim(o());
        sign(&mut e, a, 1);
        let first = e.as_("x.testnet", 0).get_btc_tx(o(), a).unwrap();
        e.as_("exec.testnet", 0).report_broadcast(o(), a, first.txid.clone());
        e.as_("exec.testnet", 0).report_failed(o(), a, "Stuck".into());
        let _ = e.as_("exec.testnet", 0).retry_transfer(o(), a);
        sign(&mut e, a, 1);
        let bumped = e.as_("x.testnet", 0).get_btc_tx(o(), a).unwrap();
        // Tobi chains on the bumped change
        let _ = e.as_("tobi.testnet", 0).claim(o());
        sign(&mut e, t, 1);
        assert_eq!(e.as_("x.testnet", 0).get_btc_tx(o(), t).unwrap().inputs[0].txid, bumped.txid);

        e.as_("exec.testnet", 0).report_broadcast(o(), a, first.txid.clone());
        let rel = e.as_("x.testnet", 0).get_btc_release(o()).unwrap();
        assert_eq!((rel.signed, rel.last), (1, Some(a)));
        assert_eq!(rel.head, vec![utxo(&first.txid, 1, first.outputs[1].value.0)]);
        let tr = e.plan().proposal.unwrap().transfers;
        assert_eq!((tr[t as usize].state, tr[t as usize].failure.as_deref()), (TransferState::Failed, Some("Rechained")));
        assert!(e.as_("x.testnet", 0).get_btc_tx(o(), t).is_none());

        let _ = e.as_("exec.testnet", 0).retry_transfer(o(), t);
        let tt = e.as_("x.testnet", 0).get_btc_tx(o(), t).unwrap();
        assert_eq!((tt.inputs[0].txid.clone(), tt.seq), (first.txid.clone(), 1));
    }

    #[test]
    #[should_panic(expected = "E_PROPOSAL_OPEN")]
    fn destinations_frozen_while_release_open() {
        let mut e = with_vault();
        proposed(&mut e, vec![utxo(COIN, 1, 100_000)]);
        e.as_("owner.testnet", NEAR / 10).set_btc_destinations(vec![]);
    }

    #[test]
    fn mode_override_by_bitcoin_group() {
        assert!(AssetGroup::Bitcoin.contains(&Asset::Btc));
        assert!(!AssetGroup::Near.contains(&Asset::Btc));
        assert!(!AssetGroup::Ethereum.contains(&Asset::Btc));
    }
}

// ------------------------------------------------- D21 follow-up rounds

mod follow_up {
    use super::*;

    fn o() -> AccountId {
        acc("owner.testnet")
    }

    /// Runs a NEAR-only release to Settled and returns the env.
    fn settle(mut e: Env) -> Env {
        let id = e.as_("g1.testnet", 0).propose_release(o(), None, None, None);
        e.as_("g2.testnet", 0).approve_release(o(), id);
        e.advance(30 * DAY);
        let _ = e.as_("amara.testnet", 0).claim(o());
        let _ = e.as_("tobi.testnet", 0).claim(o());
        let n = e.plan().proposal.unwrap().transfers.len() as u32;
        for k in 0..n {
            e.callback(vec![PromiseResult::Successful(vec![])]).on_near_transfer(o(), k);
        }
        assert_eq!(e.status(), PlanStatus::Settled);
        e
    }

    fn near_amounts(e: &mut Env) -> Vec<(String, u128)> {
        e.plan().proposal.unwrap().transfers.iter().filter(|t| t.asset == Asset::Near).map(|t| (t.heir.to_string(), t.amount.0)).collect()
    }

    #[test]
    fn owner_can_check_in_and_deposit_after_a_settled_release() {
        let mut e = settle(funded_overdue());
        e.as_("owner.testnet", 0).check_in(None);
        assert_eq!(e.status(), PlanStatus::Active);
        assert!(e.plan().proposal.is_none());
        e.as_("owner.testnet", NEAR).deposit(o());
        assert_eq!(e.plan().escrow.0, NEAR);
        let h = e.as_("x.testnet", 0).get_release_history(o());
        assert_eq!(h.len(), 1);
        assert!(h[0].transfers.iter().all(|t| t.state == TransferState::Confirmed));
    }

    #[test]
    fn snapshot_records_reported_external_balances() {
        let mut e = funded_overdue();
        e.as_("g1.testnet", 0).propose_release(o(), Some(U128(NEAR)), None, None);
        let s = e.as_("x.testnet", 0).get_release_snapshot(o());
        assert_eq!(s, vec![(Asset::Near, U128(10 * NEAR)), (Asset::Eth, U128(NEAR))]);
    }

    #[test]
    fn settled_release_shows_in_history_before_it_is_archived() {
        let mut e = settle(funded_overdue());
        assert_eq!(e.as_("x.testnet", 0).get_release_history(o()).len(), 1);
    }

    #[test]
    fn heir_starts_a_follow_up_for_a_later_deposit_and_guardians_approve() {
        let mut e = settle(funded_overdue());
        e.as_("friend.testnet", 5 * NEAR).deposit(o());
        assert_eq!(e.status(), PlanStatus::Overdue);
        let id = e.as_("amara.testnet", 0).propose_release(o(), None, None, None);
        let p = e.plan().proposal.unwrap();
        assert_eq!((p.id, p.approvals.len(), p.proposer.as_str()), (id, 0, "amara.testnet"));
        assert_eq!(near_amounts(&mut e), vec![("amara.testnet".into(), 3 * NEAR), ("tobi.testnet".into(), 2 * NEAR)]);
        assert_eq!(e.as_("x.testnet", 0).get_release_snapshot(o()), vec![(Asset::Near, U128(5 * NEAR))]);
        e.as_("g1.testnet", 0).approve_release(o(), id);
        assert_eq!(e.status(), PlanStatus::Proposed);
        e.as_("g3.testnet", 0).approve_release(o(), id);
        assert_eq!(e.status(), PlanStatus::Waiting);
        // the owner can still stop it
        e.as_("owner.testnet", 0).cancel_release();
        assert_eq!(e.plan().escrow.0, 5 * NEAR);
        assert!(e.as_("x.testnet", 0).get_release_snapshot(o()).is_empty());
    }

    #[test]
    #[should_panic(expected = "E_NOT_GUARDIAN")]
    fn heir_cannot_start_the_first_round() {
        let mut e = funded_overdue();
        e.as_("amara.testnet", 0).propose_release(o(), None, None, None);
    }

    #[test]
    #[should_panic(expected = "E_NOT_GUARDIAN")]
    fn heir_cannot_start_a_round_once_the_owner_is_back() {
        let mut e = settle(funded_overdue());
        e.as_("owner.testnet", 0).check_in(None);
        e.advance(97 * DAY);
        e.as_("amara.testnet", 0).propose_release(o(), None, None, None);
    }

    #[test]
    fn fixed_amounts_are_paid_once_across_rounds() {
        let mut e = Env::new();
        e.as_("owner.testnet", NEAR).set_plan(plan_input());
        e.as_("owner.testnet", NEAR / 100).set_release_rules(Some(ReleaseRules {
            fixed: vec![FixedAmount { heir: acc("tobi.testnet"), asset: Asset::Near, amount: U128(3 * NEAR) }],
            ..Default::default()
        }));
        e.as_("owner.testnet", 10 * NEAR).deposit(o());
        e.advance(97 * DAY);
        let id = e.as_("g1.testnet", 0).propose_release(o(), None, None, None);
        // 3 fixed to Tobi, then 60/40 of 7
        assert_eq!(near_amounts(&mut e), vec![("amara.testnet".into(), 42 * NEAR / 10), ("tobi.testnet".into(), 58 * NEAR / 10)]);
        e.as_("g2.testnet", 0).reject_release(o(), id);
        e.as_("g3.testnet", 0).reject_release(o(), id);
        // a rejected round paid nothing: the fixed amount still applies
        assert!(e.as_("x.testnet", 0).get_fixed_paid(o()).is_empty());
        let mut e = settle(e);
        assert_eq!(e.as_("x.testnet", 0).get_fixed_paid(o()), vec![]); // recorded on archive
        e.as_("friend.testnet", 5 * NEAR).deposit(o());
        let paid = e.as_("x.testnet", 0).get_fixed_paid(o());
        assert_eq!(paid, vec![FixedAmount { heir: acc("tobi.testnet"), asset: Asset::Near, amount: U128(3 * NEAR) }]);
        e.as_("g1.testnet", 0).propose_release(o(), None, None, None);
        assert_eq!(near_amounts(&mut e), vec![("amara.testnet".into(), 3 * NEAR), ("tobi.testnet".into(), 2 * NEAR)]);
    }

    #[test]
    fn rejection_returns_tokens_and_the_registration_reserve() {
        let mut e = with_wnear();
        assert_eq!(ft_deposit(&mut e, WNEAR, "owner.testnet", 1_000, ""), 0);
        e.advance(97 * DAY);
        let id = e.as_("g1.testnet", 0).propose_release(o(), None, None, None);
        assert_eq!(ft_escrow_of(&mut e), 0);
        e.as_("g2.testnet", 0).reject_release(o(), id);
        e.as_("g3.testnet", 0).reject_release(o(), id);
        assert!(e.plan().proposal.is_none());
        assert_eq!(ft_escrow_of(&mut e), 1_000);
        assert_eq!(e.plan().escrow.0, 10 * NEAR);
    }

    #[test]
    fn token_deposit_accepted_after_a_settled_release() {
        let mut e = with_wnear();
        e.advance(97 * DAY);
        let mut e = settle(e);
        assert_eq!(ft_deposit(&mut e, WNEAR, "friend.testnet", 500, "owner.testnet"), 0);
        assert_eq!(ft_escrow_of(&mut e), 500);
    }
}

// ------------------------------------------- D22 Sepolia outcome proofs

mod ethproof_vectors {
    use crate::eth::{hex_decode, hex_encode};
    use crate::ethproof::{decode, rlp_index, verify_outcome, verify_proof, Rlp};

    struct V {
        header: Vec<u8>,
        index: u64,
        tx: Vec<Vec<u8>>,
        receipt: Vec<Vec<u8>>,
    }

    fn load(json: &str) -> V {
        let j: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(json).unwrap();
        let hx = |v: &near_sdk::serde_json::Value| hex_decode(v.as_str().unwrap().trim_start_matches("0x")).unwrap();
        let list = |k: &str| j[k].as_array().unwrap().iter().map(hx).collect::<Vec<_>>();
        V { header: hx(&j["header"]), index: j["tx_index"].as_u64().unwrap(), tx: list("tx_proof"), receipt: list("receipt_proof") }
    }

    const OK: &str = include_str!("testdata/sepolia-success.json");
    const REV_TYPED: &str = include_str!("testdata/sepolia-revert-typed.json");
    const REV_LEGACY: &str = include_str!("testdata/sepolia-revert-legacy.json");

    #[test]
    fn proves_a_real_successful_transfer() {
        let v = load(OK);
        let o = verify_outcome(&v.header, v.index, &v.tx, &v.receipt).unwrap();
        assert_eq!(o.block_number, 12_090_627);
        assert_eq!(hex_encode(&o.block_hash), "552618535dd77310eae483baca65cb663c590b2f667b70eec692ff5d37a6381d");
        // Behest's first Sepolia release
        assert_eq!(hex_encode(&o.tx_hash), "38e3a54ce63bba4b1a1940981bee6fe15e3f7c5cfac17b23ff14e9314381b323");
        assert!(o.success);
    }

    #[test]
    fn proves_real_reverts_typed_and_legacy() {
        let v = load(REV_TYPED);
        let o = verify_outcome(&v.header, v.index, &v.tx, &v.receipt).unwrap();
        assert_eq!((o.block_number, o.success), (12_093_650, false));
        assert_eq!(hex_encode(&o.block_hash), "187877b8bb8ece7337924544952b66b3e1fcc5c235fd62ac591bfd453f2c3a61");
        assert_eq!(hex_encode(&o.tx_hash), "7478c4451524b6847b4b5498dfe35de9660c71dc84804324b3eda3c01a3aca91");
        let v = load(REV_LEGACY);
        let o = verify_outcome(&v.header, v.index, &v.tx, &v.receipt).unwrap();
        assert_eq!((o.block_number, o.success), (12_093_700, false));
        assert_eq!(hex_encode(&o.tx_hash), "dcc96e62159831aec3f08fad78dc938436d197b6019d2f6821afea6504bb782f");
    }

    #[test]
    fn rejects_tampered_or_mismatched_proofs() {
        let v = load(OK);
        // another index: the proofs don't lead there
        assert!(verify_outcome(&v.header, v.index + 1, &v.tx, &v.receipt).is_err());
        // receipt proof swapped for the transaction proof
        assert!(verify_outcome(&v.header, v.index, &v.tx, &v.tx).is_err());
        // one flipped byte in the last receipt node (the leaf with the status)
        let mut r = v.receipt.clone();
        let last = r.last_mut().unwrap();
        let k = last.len() - 1;
        last[k] ^= 1;
        assert!(verify_outcome(&v.header, v.index, &v.tx, &r).is_err());
        // a node added at the end
        let mut t = v.tx.clone();
        t.push(v.tx[0].clone());
        assert!(verify_outcome(&v.header, v.index, &t, &v.receipt).is_err());
        // a different header (another block's roots)
        let other = load(REV_TYPED);
        assert!(verify_outcome(&other.header, v.index, &v.tx, &v.receipt).is_err());
        // truncated header
        assert!(verify_outcome(&v.header[..v.header.len() - 1], v.index, &v.tx, &v.receipt).is_err());
    }

    #[test]
    fn rlp_and_keys() {
        assert_eq!(rlp_index(0), vec![0x80]);
        assert_eq!(rlp_index(42), vec![42]);
        assert_eq!(rlp_index(127), vec![0x7f]);
        assert_eq!(rlp_index(128), vec![0x81, 0x80]);
        assert_eq!(rlp_index(300), vec![0x82, 0x01, 0x2c]);
        assert_eq!(decode(&[0xc2, 0x01, 0x80]), Some(Rlp::List(vec![Rlp::Bytes(&[1]), Rlp::Bytes(&[])], &[0xc2, 0x01, 0x80])));
        assert_eq!(decode(&[0x81, 0x05]), None); // non-canonical single byte
        assert_eq!(decode(&[0xc2, 0x01]), None); // short
        assert!(verify_proof(&[0u8; 32], &[0x80], &[]).is_none());
    }
}

// ------------------------------------------- D22 outcome proofs (contract)

mod outcome_proofs {
    use super::*;

    #[test]
    #[should_panic(expected = "E_NO_LIGHT_CLIENT")]
    fn proving_needs_a_light_client() {
        let mut e = eth_reverted();
        let i = e.eth_index();
        let proof = EthOutcomeProof { header: "0x".into(), tx_index: 0, tx_proof: vec![], receipt_proof: vec![] };
        let _ = e.as_("amara.testnet", 0).prove_eth_outcome(acc("owner.testnet"), i, proof);
    }

    #[test]
    #[should_panic(expected = "E_INVALID_PROOF")]
    fn a_valid_proof_of_someone_elses_transaction_is_rejected() {
        let mut e = eth_reverted();
        e.as_("admin.testnet", 0).set_eth_light_client(Some(acc("client-eth2.sepolia.testnet")));
        let i = e.eth_index();
        // a real, valid Sepolia revert proof, but not a transaction this contract signed
        let j: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(include_str!("testdata/sepolia-revert-typed.json")).unwrap();
        let proof: EthOutcomeProof = near_sdk::serde_json::from_value(j).unwrap();
        let _ = e.as_("amara.testnet", 0).prove_eth_outcome(acc("owner.testnet"), i, proof);
    }

    #[test]
    #[should_panic(expected = "E_INVALID_PROOF")]
    fn a_tampered_proof_is_rejected() {
        let mut e = eth_reverted();
        e.as_("admin.testnet", 0).set_eth_light_client(Some(acc("client-eth2.sepolia.testnet")));
        let i = e.eth_index();
        let j: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(include_str!("testdata/sepolia-success.json")).unwrap();
        let mut proof: EthOutcomeProof = near_sdk::serde_json::from_value(j).unwrap();
        proof.tx_index += 1;
        let _ = e.as_("amara.testnet", 0).prove_eth_outcome(acc("owner.testnet"), i, proof);
    }

    #[test]
    fn a_block_the_light_client_does_not_hold_as_final_proves_nothing() {
        let mut e = eth_reverted();
        let i = e.eth_index();
        let h = e.signed_hash(i);
        assert!(!e.proven(i, h.clone(), false, None));
        let other = "0x0000000000000000000000000000000000000000000000000000000000000001";
        assert!(!e.proven(i, h, false, Some(other)));
        assert_eq!(e.c.get_revert_proof(acc("owner.testnet"), i), None);
    }

    #[test]
    fn a_proven_revert_unlocks_one_reissue() {
        let mut e = eth_proven_revert();
        let i = e.eth_index();
        let h = e.signed_hash(i);
        assert_eq!(e.c.get_revert_proof(acc("owner.testnet"), i), Some(h.clone()));
        let _ = e.as_("tobi.testnet", 0).reissue_reverted_transfer(acc("owner.testnet"), i);
        assert_eq!(e.c.get_revert_proof(acc("owner.testnet"), i), None);
        assert_eq!(e.eth_transfer().eth_tx.unwrap().nonce, 1);
        // the old nonce's revert can't be proven again against the new nonce
        assert!(!e.proven(i, h, false, Some(BLOCK)));
    }

    #[test]
    fn a_proven_success_confirms_even_after_a_false_failure_report() {
        let mut e = eth_reverted(); // the executor said "Reverted"; it wasn't
        let i = e.eth_index();
        let h = e.signed_hash(i);
        assert!(e.proven(i, h.clone(), true, Some(BLOCK)));
        let tr = e.eth_transfer();
        assert_eq!((tr.state, tr.failure, tr.tx_hash), (TransferState::Confirmed, None, Some(h)));
        assert_eq!(e.c.get_revert_proof(acc("owner.testnet"), i), None);
    }

    #[test]
    #[should_panic(expected = "E_UNAUTHORIZED")]
    fn only_admin_sets_the_light_client() {
        let mut e = eth_reverted();
        e.as_("amara.testnet", 0).set_eth_light_client(Some(acc("evil.testnet")));
    }
}

// ------------------------------------------------- EVM wallets (D23) and D24

const RELAYER: &str = "relayer.testnet";

fn evm_vectors() -> near_sdk::serde_json::Value {
    near_sdk::serde_json::from_str(include_str!("testdata/evm-vectors.json")).unwrap()
}

/// (message, signature) of a vector made by tools/testnet/src/gen-evm-vectors.ts.
fn vector(name: &str) -> (String, String) {
    let v = &evm_vectors()["vectors"][name];
    (v["message"].as_str().unwrap_or_else(|| panic!("no vector {name}")).to_string(), v["signature"].as_str().unwrap().to_string())
}

fn evm_addr(k: &str) -> AccountId {
    evm_vectors()["addresses"][k].as_str().unwrap().parse().unwrap()
}

/// Runs `f` and returns the panic message (the contract's error code).
fn panic_code<R>(f: impl FnOnce() -> R) -> String {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
    std::panic::set_hook(prev);
    let msg = match r {
        Ok(_) => return "no panic".into(),
        Err(e) => e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default(),
    };
    // The mocked VM wraps the code: `…GuestPanic { panic_msg: "E_…" }`.
    match msg.find("E_") {
        Some(i) => msg[i..].chars().take_while(|c| c.is_ascii_uppercase() || *c == '_' || c.is_ascii_digit()).collect(),
        None => msg,
    }
}

impl Env {
    /// A call whose transaction `signer` signed and `who` is the predecessor
    /// of (a meta-transaction: who = the user, signer = the relayer).
    fn via(&mut self, who: &str, signer: &str, deposit: u128) -> &mut Contract {
        let ctx = VMContextBuilder::new()
            .current_account_id(acc("behest.testnet"))
            .predecessor_account_id(acc(who))
            .signer_account_id(acc(signer))
            .block_timestamp(self.t * 1_000_000)
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .account_balance(NearToken::from_near(1_000))
            .build();
        testing_env!(ctx);
        &mut self.c
    }

    /// The relayer submits a signed action.
    fn evm(&mut self, name: &str) -> PromiseOrValue<near_sdk::serde_json::Value> {
        let (m, s) = vector(name);
        self.via(RELAYER, RELAYER, 0).evm_call(m, s)
    }

    fn evm_err(&mut self, name: &str) -> String {
        let (m, s) = vector(name);
        self.evm_raw_err(m, s)
    }

    fn evm_raw_err(&mut self, m: String, s: String) -> String {
        let c = self.via(RELAYER, RELAYER, 0);
        panic_code(move || c.evm_call(m, s))
    }

    fn sponsor(&mut self, pool: u128) {
        self.as_("admin.testnet", 0).set_sponsor_config(evm::SponsorConfig { relayer: Some(acc(RELAYER)), ..Default::default() });
        if pool > 0 {
            self.as_("anyone.testnet", pool).fund_sponsor_pool();
        }
    }

    fn sponsorship(&mut self, owner: &AccountId) -> evm::SponsorshipView {
        self.as_("anyone.testnet", 0).get_sponsorship(owner.clone())
    }
}

fn value(r: PromiseOrValue<near_sdk::serde_json::Value>) -> near_sdk::serde_json::Value {
    match r {
        PromiseOrValue::Value(v) => v,
        PromiseOrValue::Promise(_) => panic!("expected a value"),
    }
}

#[test]
fn evm_vectors_recover_their_signers() {
    let mut e = Env::new();
    e.as_("anyone.testnet", 0);
    let (m, s) = vector("owner_check_in_0");
    assert_eq!(evm::recover(&m, &s), evm_addr("a").to_string());
    let (m, s) = vector("utf8_summary"); // the length prefix counts UTF-8 bytes
    assert_eq!(evm::recover(&m, &s), evm_addr("a").to_string());
    let (m, s) = vector("heir_claim");
    assert_eq!(evm::recover(&m, &s), evm_addr("c").to_string());
    // v as 0/1 is accepted like 27/28.
    let (m, s) = vector("owner_check_in_0");
    let v = u8::from_str_radix(&s[130..], 16).unwrap() - 27;
    assert_eq!(evm::recover(&m, &format!("{}{:02x}", &s[..130], v)), evm_addr("a").to_string());
}

#[test]
fn evm_owner_creates_a_sponsored_plan_and_checks_in() {
    let mut e = Env::new();
    e.sponsor(NEAR);
    let a = evm_addr("a");
    assert_eq!(e.as_("anyone.testnet", 0).get_evm_nonce(a.clone()), U64(0));
    let before = e.sponsorship(&a);
    assert_eq!((before.pool, before.allowance_left, before.daily_left), (U128(NEAR), U128(evm::DEFAULT_ALLOWANCE), 50));

    assert_eq!(value(e.evm("owner_set_plan")), near_sdk::serde_json::Value::Null);
    let p = e.as_("anyone.testnet", 0).get_plan(a.clone()).expect("plan created for the 0x account");
    assert_eq!(p.plan.owner, a);
    assert_eq!(e.as_("anyone.testnet", 0).get_evm_nonce(a.clone()), U64(1));
    let after = e.sponsorship(&a);
    let cost = NEAR - after.pool.0;
    assert!(cost > 0 && cost < NEAR / 100, "storage cost {cost}");
    assert_eq!(after.allowance_left.0, evm::DEFAULT_ALLOWANCE - cost);
    assert_eq!(after.daily_left, 49);

    // Replay of the same signed action.
    assert_eq!(e.evm_err("owner_set_plan"), "E_EVM_NONCE");
    // The next nonce works, and acting-as is gone afterwards.
    e.advance(DAY);
    let _ = e.evm("owner_check_in_1");
    assert_eq!(evm::acting_as(), None);
    assert_eq!(e.as_("anyone.testnet", 0).get_plan(a.clone()).unwrap().plan.last_check_in_ms, e.t);
    assert_eq!(e.as_("anyone.testnet", 0).get_evm_nonce(a), U64(2));
}

#[test]
fn evm_signed_action_checks() {
    let mut e = Env::new();
    e.sponsor(NEAR);
    for (name, code) in [
        ("wrong_contract", "E_EVM_WRONG_CONTRACT"),
        ("wrong_network", "E_EVM_WRONG_CONTRACT"),
        ("wrong_actor", "E_EVM_ACTOR"),
        ("expired", "E_EVM_EXPIRED"),
        ("wrong_nonce", "E_EVM_NONCE"),
        ("padded_nonce", "E_EVM_MESSAGE"),
        ("high_s", "E_EVM_SIGNATURE"),
        ("method_deposit", "E_EVM_METHOD"),
        ("method_set_paused", "E_EVM_METHOD"),
        ("method_add_executor", "E_EVM_METHOD"),
        ("method_evm_call", "E_EVM_METHOD"),
        ("extra_field", "E_EVM_MESSAGE"),
        ("no_blank_line", "E_EVM_MESSAGE"),
    ] {
        assert_eq!(e.evm_err(name), code, "{name}");
        assert_eq!(evm::acting_as(), None, "{name}");
    }
    let (m, s) = vector("owner_check_in_0");
    // Wrong length, not hex, no 0x, bad v.
    assert_eq!(e.evm_raw_err(m.clone(), s[..130].to_string()), "E_EVM_SIGNATURE");
    assert_eq!(e.evm_raw_err(m.clone(), format!("{s}00")), "E_EVM_SIGNATURE");
    assert_eq!(e.evm_raw_err(m.clone(), s[2..].to_string()), "E_EVM_SIGNATURE");
    assert_eq!(e.evm_raw_err(m.clone(), format!("{}zz", &s[..130])), "E_EVM_SIGNATURE");
    assert_eq!(e.evm_raw_err(m.clone(), format!("{}1d", &s[..130])), "E_EVM_SIGNATURE");
    // r = 0 / s = 0.
    assert_eq!(e.evm_raw_err(m.clone(), format!("0x{}{}", "0".repeat(64), &s[66..])), "E_EVM_SIGNATURE");
    assert_eq!(e.evm_raw_err(m.clone(), format!("{}{}{}", &s[..66], "0".repeat(64), &s[130..])), "E_EVM_SIGNATURE");
    // A changed message no longer recovers to the actor.
    assert_eq!(e.evm_raw_err(m.replace("Check in", "Check in!"), s.clone()), "E_EVM_ACTOR");
    // A different header.
    assert_eq!(e.evm_raw_err(m.replace("Behest signed action", "Behest signed actions"), s.clone()), "E_EVM_MESSAGE");
    // Unknown argument: what was signed must be exactly what runs. Needs a plan first.
    let _ = e.evm("owner_set_plan");
    // None of the refused actions above used up a nonce.
    assert_eq!(e.as_("anyone.testnet", 0).get_evm_nonce(evm_addr("a")), U64(1));
    assert_eq!(e.evm_err("unknown_arg"), "E_EVM_ARGS");
}

#[test]
fn evm_acting_as_is_cleared_when_the_method_fails() {
    let mut e = Env::new();
    // No plan for 0x…a: check_in panics inside the dispatch, after acting-as was set.
    assert_eq!(e.evm_err("owner_check_in_0"), "E_NO_PLAN");
    assert_eq!(evm::acting_as(), None);
    // A later direct call sees its own predecessor.
    e.as_("owner.testnet", NEAR).set_plan(plan_input());
    assert!(e.as_("anyone.testnet", 0).get_plan(acc("owner.testnet")).is_some());
    assert!(e.as_("anyone.testnet", 0).get_plan(acc(RELAYER)).is_none());
}

#[test]
fn evm_never_runs_from_the_contract_itself() {
    let mut e = Env::new();
    let (m, s) = vector("owner_check_in_0");
    let c = e.via("behest.testnet", "behest.testnet", 0);
    assert_eq!(panic_code(move || c.evm_call(m, s)), "E_EVM_METHOD");
}

/// owner.testnet's plan with an EVM guardian (b) and an EVM heir (c).
fn evm_roles_plan() -> Env {
    let mut e = Env::new();
    let mut p = plan_input();
    p.guardians[0] = evm_addr("b");
    p.heirs[0] = HeirInput { account_id: evm_addr("c"), share_bps: 6000, near_destination: Some(evm_addr("c")), eth_destination: None };
    e.as_("owner.testnet", NEAR).set_plan(p);
    e.as_("owner.testnet", 10 * NEAR).deposit(acc("owner.testnet"));
    e.advance(97 * DAY);
    e
}

#[test]
fn evm_guardian_proposes_and_heir_claims() {
    let mut e = evm_roles_plan();
    let id = value(e.evm("guardian_propose")).as_u64().unwrap();
    let p = e.plan().proposal.unwrap();
    assert_eq!(p.approvals, vec![evm_addr("b")], "the EVM guardian's proposal counts as its approval");
    e.as_("g2.testnet", 0).approve_release(acc("owner.testnet"), id);
    e.advance(30 * DAY);
    assert_eq!(value(e.evm("heir_claim")), near_sdk::serde_json::json!(1));
    let receipts = near_sdk::test_utils::get_created_receipts();
    let tr = e.plan().proposal.unwrap().transfers.into_iter().find(|t| t.heir == evm_addr("c")).unwrap();
    assert_eq!(tr.state, TransferState::Sending);
    assert_eq!(tr.destination, evm_addr("c").to_string());
    assert!(receipts.iter().any(|r| r.receiver_id == evm_addr("c")), "NEAR goes to the heir's 0x account");
}

#[test]
fn evm_signature_never_grants_executor_or_admin() {
    let mut e = evm_roles_plan();
    let d = evm_addr("d");
    e.as_("admin.testnet", 0).add_executor(d.clone());
    // Even an admin key can't use admin methods through a signature.
    let admin = std::mem::replace(&mut e.c.admin, d.clone());
    assert_eq!(e.evm_err("method_set_paused"), "E_EVM_METHOD");
    e.c.admin = admin;
    // As a registered executor, d may cancel anyone's withdrawal directly (E_NO_WITHDRAWAL:
    // past the role check); through evm_call the executor role doesn't apply.
    let c = e.as_(d.as_str(), 0);
    assert_eq!(panic_code(move || c.cancel_vault_withdrawal(acc("owner.testnet"))), "E_NO_WITHDRAWAL");
    assert_eq!(e.evm_err("executor_cancel_withdrawal"), "E_UNAUTHORIZED");
    // And the privileged checks refuse under acting-as outright.
    let g = evm::ActingAs::enter(acc("admin.testnet"));
    let c = e.as_("admin.testnet", 0);
    assert_eq!(panic_code(move || c.set_paused(true)), "E_UNAUTHORIZED");
    drop(g);
    assert_eq!(evm::acting_as(), None);
}

// ----------------------------------------------------------------- D24

#[test]
fn sponsored_meta_tx_plan_uses_the_pool() {
    // (The mocked chain keeps state written before a panic, so each failing
    // attempt uses its own owner.)
    let mut e = Env::new();
    let owner = acc("owner.testnet");
    // Not configured: a 0-deposit plan still needs a deposit.
    let c = e.via("o1.testnet", RELAYER, 0);
    assert_eq!(panic_code(move || c.set_plan(plan_input())), "E_INSUFFICIENT_DEPOSIT");
    // Configured but empty.
    e.sponsor(0);
    let c = e.via("o2.testnet", RELAYER, 0);
    assert_eq!(panic_code(move || c.set_plan(plan_input())), "E_SPONSOR_EXHAUSTED");
    e.sponsor(NEAR);
    // Someone else's transaction isn't sponsored.
    let c = e.via("o3.testnet", "o3.testnet", 0);
    assert_eq!(panic_code(move || c.set_plan(plan_input())), "E_INSUFFICIENT_DEPOSIT");
    e.via("owner.testnet", RELAYER, 0).set_plan(plan_input());
    assert!(near_sdk::test_utils::get_created_receipts().is_empty(), "nothing is paid out");
    let s = e.sponsorship(&owner);
    assert!(s.pool.0 < NEAR && s.daily_left == 49);
    let paid = evm::sponsored(&owner).unwrap();
    assert_eq!(paid.spent, NEAR - s.pool.0);
    assert_eq!(paid.spent, paid.bytes as u128 * STORAGE_BYTE_COST);
}

#[test]
fn sponsorship_caps() {
    let mut e = Env::new();
    e.as_("admin.testnet", 0).set_sponsor_config(evm::SponsorConfig { relayer: Some(acc(RELAYER)), allowance_per_owner: U128(NEAR), daily_new_plans: 1 });
    e.as_("anyone.testnet", NEAR).fund_sponsor_pool();
    e.via("owner.testnet", RELAYER, 0).set_plan(plan_input());
    // Second new plan the same day.
    let c = e.via("other.testnet", RELAYER, 0);
    assert_eq!(panic_code(move || c.set_plan(plan_input())), "E_SPONSOR_EXHAUSTED");
    assert_eq!(e.sponsorship(&acc("other.testnet")).daily_left, 0);
    // Paying works; and the next day the cap resets.
    e.via("other.testnet", RELAYER, NEAR).set_plan(plan_input());
    e.advance(DAY);
    assert_eq!(e.sponsorship(&acc("x.testnet")).daily_left, 1);
    // Per-owner allowance: a tiny one is exhausted by any growth.
    e.as_("admin.testnet", 0).set_sponsor_config(evm::SponsorConfig { relayer: Some(acc(RELAYER)), allowance_per_owner: U128(1), daily_new_plans: 50 });
    let c = e.via("third.testnet", RELAYER, 0);
    assert_eq!(panic_code(move || c.set_plan(plan_input())), "E_SPONSOR_EXHAUSTED");
    // Admin only.
    let c = e.as_("owner.testnet", 0);
    assert_eq!(panic_code(move || c.set_sponsor_config(evm::SponsorConfig::default())), "E_UNAUTHORIZED");
}

#[test]
fn freed_sponsored_storage_returns_to_the_pool_not_the_owner() {
    let mut e = Env::new();
    e.sponsor(NEAR);
    let owner = acc("owner.testnet");
    e.via("owner.testnet", RELAYER, 0).set_plan(plan_input());
    let pool0 = e.sponsorship(&owner).pool.0;
    e.via("owner.testnet", RELAYER, 0).set_release_rules(Some(rules()));
    let pool1 = e.sponsorship(&owner).pool.0;
    assert!(pool1 < pool0);
    let spent = evm::sponsored(&owner).unwrap().spent;
    // Clearing the rules (paying nothing, not sponsored) frees storage: the
    // pool gets its part back, the owner nothing, the allowance stays spent.
    e.via("owner.testnet", "owner.testnet", 0).set_release_rules(None);
    assert!(near_sdk::test_utils::get_created_receipts().is_empty(), "no refund to the owner");
    assert_eq!(e.sponsorship(&owner).pool.0, pool0);
    assert_eq!(evm::sponsored(&owner).unwrap().spent, spent);
    // Storage the owner paid for isn't credited to the pool beyond what the pool paid.
    e.as_("owner.testnet", NEAR / 100).set_release_rules(Some(rules()));
    let bytes = evm::sponsored(&owner).unwrap().bytes;
    e.as_("owner.testnet", 0).set_release_rules(None);
    let back = e.sponsorship(&owner).pool.0 - pool0;
    assert_eq!(back, (bytes - evm::sponsored(&owner).unwrap().bytes) as u128 * STORAGE_BYTE_COST);
    assert!(e.sponsorship(&owner).pool.0 <= NEAR);
}

#[test]
fn paying_owners_are_not_charged_to_the_pool() {
    let mut e = Env::new();
    e.sponsor(NEAR);
    let owner = acc("owner.testnet");
    // Attached deposit with the relayer as signer: the deposit pays.
    e.via("owner.testnet", RELAYER, NEAR).set_plan(plan_input());
    assert_eq!(e.sponsorship(&owner).pool.0, NEAR);
    assert!(evm::sponsored(&owner).is_none());
}

#[test]
fn fund_sponsor_pool_needs_a_deposit() {
    let mut e = Env::new();
    let c = e.as_("anyone.testnet", 0);
    assert_eq!(panic_code(move || c.fund_sponsor_pool()), "E_INSUFFICIENT_DEPOSIT");
    assert_eq!(e.as_("anyone.testnet", 5).fund_sponsor_pool(), U128(5));
    assert_eq!(e.as_("anyone.testnet", 0).get_config().sponsor, evm::SponsorConfig::default());
}

// ------------------------------------------------------- plan tiers (D25)

const USDC: &str = "usdc.testnet";
const DOLLAR: u128 = 1_000_000;

impl Env {
    fn with_tiers(mut self) -> Self {
        let cfg = tiers::TierConfig { fee_token: Some(acc(USDC)), ..Default::default() };
        self.as_("admin.testnet", 0).set_tier_config(cfg);
        self
    }

    fn pay(&mut self, payer: &str, owner: &str, amount: u128) -> u128 {
        ft_deposit(self, USDC, payer, amount, &format!("{{\"pay_tier\":\"{owner}\"}}"))
    }

    fn tier(&mut self, owner: &str) -> tiers::TierView {
        self.as_("x.testnet", 0).get_tier(acc(owner))
    }
}

/// One heir, NEAR only, two guardians: fits the free tier.
fn free_plan() -> PlanInput {
    let mut p = plan_input();
    p.heirs = vec![HeirInput { account_id: acc("amara.testnet"), share_bps: 10_000, near_destination: Some(acc("amara.testnet")), eth_destination: None }];
    p
}

#[test]
fn tiers_are_off_until_a_fee_token_is_set() {
    let mut e = Env::new();
    e.as_("owner.testnet", NEAR).set_plan(plan_input());
    e.as_("owner.testnet", NEAR / 100).set_release_options(Some(opts(ReleaseMode::Automatic)));
    let t = e.tier("owner.testnet");
    assert!(!t.enabled);
    assert_eq!(t.required, 2);
}

#[test]
fn free_tier_takes_one_heir_with_near_only() {
    let mut e = Env::new().with_tiers();
    e.as_("owner.testnet", NEAR).set_plan(free_plan());
    assert_eq!(e.tier("owner.testnet").required, 0);
    // A second heir, or an Ethereum destination, needs Standard.
    assert_eq!(panic_code(|| e.as_("owner.testnet", NEAR).set_plan(plan_input())), "E_TIER_REQUIRED");
    let mut eth = free_plan();
    eth.heirs[0].eth_destination = Some("0x71C7656EC7ab88b098defB751B7401B5f6d8976F".into());
    assert_eq!(panic_code(|| e.as_("owner.testnet", NEAR).set_plan(eth.clone())), "E_TIER_REQUIRED");
    // A new owner is checked too.
    assert_eq!(panic_code(|| e.as_("new.testnet", NEAR).set_plan(plan_input())), "E_TIER_REQUIRED");
    // Rules and Bitcoin destinations are refused; editing timers is not.
    assert_eq!(panic_code(|| e.as_("owner.testnet", NEAR / 100).set_release_rules(Some(ReleaseRules { claim_window_ms: WINDOW, ..Default::default() }))), "E_TIER_REQUIRED");
    assert_eq!(
        panic_code(|| e.as_("owner.testnet", NEAR / 100).set_btc_destinations(vec![BtcDestination { account_id: acc("amara.testnet"), address: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx".into() }])),
        "E_TIER_REQUIRED"
    );
    let mut longer = free_plan();
    longer.check_in_interval_ms = 120 * DAY;
    e.as_("owner.testnet", NEAR).set_plan(longer);
}

#[test]
fn payments_add_up_and_upgrades_cost_the_difference() {
    let mut e = Env::new().with_tiers();
    e.as_("owner.testnet", NEAR).set_plan(free_plan());
    let t = e.tier("owner.testnet");
    assert_eq!((t.tier, t.due.clone()), (0, vec![U128(0), U128(49 * DOLLAR), U128(149 * DOLLAR)]));
    // Anyone may pay, in parts; part payments are credit.
    assert_eq!(e.pay("aunt.testnet", "owner.testnet", 20 * DOLLAR), 0);
    assert_eq!(e.tier("owner.testnet").tier, 0);
    assert_eq!(e.pay("owner.testnet", "owner.testnet", 30 * DOLLAR), 0);
    let t = e.tier("owner.testnet");
    assert_eq!((t.tier, t.tier_name.as_str(), t.paid.0), (1, "Standard", 50 * DOLLAR));
    // Complete costs only what is still missing; the extra dollar counts.
    assert_eq!(t.due, vec![U128(0), U128(0), U128(99 * DOLLAR)]);
    e.as_("owner.testnet", NEAR).set_plan(plan_input());
    e.as_("owner.testnet", NEAR / 100).set_release_rules(Some(rules()));
    assert_eq!(panic_code(|| e.as_("owner.testnet", NEAR / 100).set_release_options(Some(opts(ReleaseMode::Automatic)))), "E_TIER_REQUIRED");
    // Claim mode without delay signers or overrides is not "advanced".
    let plain = ReleaseOptions { mode: ReleaseMode::Claim, delay_signers: vec![], delay_quorum: 0, max_extension_ms: 0, max_total_extension_ms: 0, ..opts(ReleaseMode::Claim) };
    e.as_("owner.testnet", NEAR / 100).set_release_options(Some(plain));
    e.pay("owner.testnet", "owner.testnet", 99 * DOLLAR);
    assert_eq!(e.tier("owner.testnet").tier, 2);
    e.as_("owner.testnet", NEAR / 100).set_release_options(Some(opts(ReleaseMode::Automatic)));
    let tr = e.as_("x.testnet", 0).get_treasury();
    assert_eq!((tr.collected.0, tr.balance.0, tr.payments), (149 * DOLLAR, 149 * DOLLAR, 3));
}

#[test]
fn a_paid_tier_survives_simplifying_and_price_rises() {
    let mut e = Env::new().with_tiers();
    e.pay("owner.testnet", "owner.testnet", 49 * DOLLAR);
    e.as_("owner.testnet", NEAR).set_plan(free_plan());
    // Prices double: what was bought stays bought.
    let mut cfg = e.as_("x.testnet", 0).get_tier_config();
    cfg.tiers[1].price = U128(98 * DOLLAR);
    cfg.tiers[2].price = U128(298 * DOLLAR);
    e.as_("admin.testnet", 0).set_tier_config(cfg);
    let t = e.tier("owner.testnet");
    assert_eq!((t.tier, t.required, t.due[2].0), (1, 0, 249 * DOLLAR));
    e.as_("owner.testnet", NEAR).set_plan(plan_input());
}

#[test]
fn plans_saved_before_tiers_stay_editable_at_their_level() {
    let mut e = Env::new();
    e.as_("owner.testnet", NEAR).set_plan(plan_input());
    e.as_("owner.testnet", NEAR / 100).set_release_rules(Some(rules()));
    let mut e = e.with_tiers();
    assert_eq!(e.tier("owner.testnet").allowance, 1);
    let mut p = plan_input();
    p.waiting_period_ms = 20 * DAY;
    e.as_("owner.testnet", NEAR).set_plan(p);
    e.as_("owner.testnet", NEAR / 100).set_release_rules(None);
    // Still allowed: the plan uses Standard features (two heirs, an Ethereum destination).
    e.as_("owner.testnet", NEAR / 100).set_release_rules(Some(rules()));
    assert_eq!(panic_code(|| e.as_("owner.testnet", NEAR / 100).set_release_options(Some(opts(ReleaseMode::Hybrid)))), "E_TIER_REQUIRED");
    // Simplified to the free tier, the old level is gone.
    e.as_("owner.testnet", NEAR / 100).set_release_rules(None);
    e.as_("owner.testnet", NEAR).set_plan(free_plan());
    assert_eq!(panic_code(|| e.as_("owner.testnet", NEAR).set_plan(plan_input())), "E_TIER_REQUIRED");
}

#[test]
fn tiers_never_block_a_release() {
    let mut e = Env::new().with_executor();
    e.as_("owner.testnet", NEAR).set_plan(plan_input());
    e.as_("owner.testnet", 10 * NEAR).deposit(acc("owner.testnet"));
    let mut e = e.with_tiers();
    e.advance(97 * DAY);
    let id = e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), None, None, None);
    e.as_("g2.testnet", 0).approve_release(acc("owner.testnet"), id);
    e.advance(31 * DAY);
    e.as_("amara.testnet", 0).claim(acc("owner.testnet"));
    e.as_("tobi.testnet", 0).claim(acc("owner.testnet"));
}

#[test]
fn token_escrow_needs_a_tier_with_external_assets() {
    let mut e = Env::new().with_executor();
    e.as_("admin.testnet", REG).set_nep141_tokens(vec![Nep141Token { account_id: acc(WNEAR), symbol: "wNEAR".into(), decimals: 24, storage_deposit: U128(REG) }]);
    let mut e = e.with_tiers();
    e.as_("owner.testnet", NEAR).set_plan(free_plan());
    assert_eq!(ft_deposit(&mut e, WNEAR, "owner.testnet", 1_000, ""), 1_000);
    e.pay("owner.testnet", "owner.testnet", 49 * DOLLAR);
    assert_eq!(ft_deposit(&mut e, WNEAR, "owner.testnet", 1_000, ""), 0);
}

#[test]
fn malformed_or_dust_payments_are_refunded() {
    let mut e = Env::new().with_tiers();
    // Not a payment message, and USDC isn't an escrow token: refunded.
    assert_eq!(ft_deposit(&mut e, USDC, "owner.testnet", 49 * DOLLAR, "owner.testnet"), 49 * DOLLAR);
    assert_eq!(ft_deposit(&mut e, USDC, "owner.testnet", 49 * DOLLAR, r#"{"pay_tier":"owner.testnet","x":1}"#), 49 * DOLLAR);
    // Another token with a payment message: refunded.
    assert_eq!(ft_deposit(&mut e, "fake-usdc.testnet", "owner.testnet", 49 * DOLLAR, r#"{"pay_tier":"owner.testnet"}"#), 49 * DOLLAR);
    // A first payment under one token is refused; later small ones are credit.
    assert_eq!(e.pay("x.testnet", "owner.testnet", DOLLAR - 1), DOLLAR - 1);
    assert_eq!(e.pay("x.testnet", "owner.testnet", DOLLAR), 0);
    assert_eq!(e.pay("x.testnet", "owner.testnet", 1), 0);
    assert_eq!(e.tier("owner.testnet").paid.0, DOLLAR + 1);
    // An Ethereum-wallet owner can be paid for by anyone.
    let evm_owner = format!("0x{}", "ab".repeat(20));
    assert_eq!(e.pay("friend.testnet", &evm_owner, 49 * DOLLAR), 0);
    assert_eq!(e.tier(&evm_owner).tier, 1);
}

#[test]
fn treasury_withdrawals_are_admin_only_and_restored_on_failure() {
    let mut e = Env::new().with_tiers();
    e.pay("owner.testnet", "owner.testnet", 149 * DOLLAR);
    assert_eq!(panic_code(|| e.as_("owner.testnet", 0).withdraw_treasury(U128(DOLLAR), acc("owner.testnet"))), "E_UNAUTHORIZED");
    assert_eq!(panic_code(|| e.as_("admin.testnet", 0).withdraw_treasury(U128(150 * DOLLAR), acc("ops.testnet"))), "E_INSUFFICIENT_TREASURY");
    let _ = e.as_("admin.testnet", 0).withdraw_treasury(U128(100 * DOLLAR), acc("ops.testnet"));
    assert_eq!(e.as_("x.testnet", 0).get_treasury().balance.0, 49 * DOLLAR);
    e.callback(vec![PromiseResult::Failed]).on_treasury_withdraw(U128(100 * DOLLAR));
    let t = e.as_("x.testnet", 0).get_treasury();
    assert_eq!((t.balance.0, t.withdrawn.0, t.pending.0), (149 * DOLLAR, 0, 0));
    let _ = e.as_("admin.testnet", 0).withdraw_treasury(U128(100 * DOLLAR), acc("ops.testnet"));
    e.callback(vec![PromiseResult::Successful(vec![])]).on_treasury_withdraw(U128(100 * DOLLAR));
    let t = e.as_("x.testnet", 0).get_treasury();
    assert_eq!((t.balance.0, t.withdrawn.0, t.collected.0), (49 * DOLLAR, 100 * DOLLAR, 149 * DOLLAR));
    // Paying a tier never touches plan escrow or the sponsor pool.
    assert_eq!(e.sponsorship(&acc("owner.testnet")).pool.0, 0);
}

#[test]
fn tier_schedules_are_checked() {
    let mut e = Env::new().with_tiers();
    let good = e.as_("x.testnet", 0).get_tier_config();
    let mut bad = good.clone();
    bad.tiers[0].price = U128(1);
    assert_eq!(panic_code(|| e.as_("admin.testnet", 0).set_tier_config(bad.clone())), "E_INVALID_TIERS");
    let mut bad = good.clone();
    bad.tiers[2].price = bad.tiers[1].price;
    assert_eq!(panic_code(|| e.as_("admin.testnet", 0).set_tier_config(bad.clone())), "E_INVALID_TIERS");
    let mut bad = good.clone();
    bad.tiers[2].advanced_release = false; // the last tier must allow everything
    assert_eq!(panic_code(|| e.as_("admin.testnet", 0).set_tier_config(bad.clone())), "E_INVALID_TIERS");
    let mut bad = good.clone();
    bad.tiers[1].max_heirs = 0;
    assert_eq!(panic_code(|| e.as_("admin.testnet", 0).set_tier_config(bad.clone())), "E_INVALID_TIERS");
    assert_eq!(panic_code(|| e.as_("owner.testnet", 0).set_tier_config(good.clone())), "E_UNAUTHORIZED");
    // The fee token is fixed once anything has been collected.
    e.pay("owner.testnet", "owner.testnet", DOLLAR);
    let moved = tiers::TierConfig { fee_token: Some(acc("other-usdc.testnet")), ..good };
    assert_eq!(panic_code(|| e.as_("admin.testnet", 0).set_tier_config(moved)), "E_INVALID_TIERS");
}

#[test]
fn required_tier_view_matches_the_checks() {
    let mut e = Env::new().with_tiers();
    let c = e.as_("x.testnet", 0);
    assert_eq!(c.required_tier(free_plan(), None, None, None, None), 0);
    assert_eq!(c.required_tier(free_plan(), None, None, Some(1), None), 1);
    assert_eq!(c.required_tier(free_plan(), None, None, None, Some(true)), 1);
    assert_eq!(c.required_tier(plan_input(), Some(rules()), None, None, None), 1);
    assert_eq!(c.required_tier(free_plan(), None, Some(opts(ReleaseMode::Claim)), None, None), 2);
    let mut big = plan_input();
    for i in 0..4 {
        big.guardians.push(acc(&format!("g{}.testnet", i + 4)));
    }
    assert_eq!(c.required_tier(big, None, None, None, None), 2);
}

// ------------------------------------------- DAOs and check-in delegates (D26)

const DAO: &str = "family.sputnikv2.testnet";
const COUNCIL: &str = "kemi.testnet";
const GUARD_DAO: &str = "guards.sputnikv2.testnet";
const HEIR_DAO: &str = "trust.sputnikv2.testnet";

/// A plan whose owner names two check-in delegates (tiers off).
fn delegated() -> Env {
    let mut e = Env::new();
    e.as_("owner.testnet", NEAR).set_plan(plan_input());
    e.as_("owner.testnet", 10 * NEAR).deposit(acc("owner.testnet"));
    e.as_("owner.testnet", NEAR / 100).set_checkin_delegates(vec![acc("d1.testnet"), acc("d2.testnet")]);
    e
}

#[test]
fn a_delegate_checks_in_for_the_owner() {
    let mut e = delegated();
    assert_eq!(e.as_("x.testnet", 0).get_checkin_delegates(acc("owner.testnet")), vec![acc("d1.testnet"), acc("d2.testnet")]);
    e.advance(96 * DAY);
    assert_eq!(e.status(), PlanStatus::Active);
    e.as_("d1.testnet", 0).check_in(Some(acc("owner.testnet")));
    assert_eq!(e.plan().last_check_in_ms, e.t);
    e.advance(96 * DAY);
    assert_eq!(e.status(), PlanStatus::Active, "the delegate's check-in restarted the clock");
    // Overdue with nothing proposed yet: a delegate may still check in.
    e.advance(2 * DAY);
    assert_eq!(e.status(), PlanStatus::Overdue);
    e.as_("d2.testnet", 0).check_in(Some(acc("owner.testnet")));
    assert_eq!(e.status(), PlanStatus::Active);
    // Naming yourself is an ordinary check-in.
    e.as_("owner.testnet", 0).check_in(Some(acc("owner.testnet")));
}

#[test]
fn a_delegate_can_do_nothing_else() {
    let mut e = delegated();
    assert_eq!(panic_code(|| e.as_("x.testnet", 0).check_in(Some(acc("owner.testnet")))), "E_NOT_DELEGATE");
    // Every other owner method acts on the caller's own plan, which a delegate doesn't have.
    assert_eq!(panic_code(|| e.as_("d1.testnet", 0).withdraw(U128(1))), "E_NO_PLAN");
    assert_eq!(panic_code(|| e.as_("d1.testnet", 0).cancel_release()), "E_NO_PLAN");
    assert_eq!(panic_code(|| e.as_("d1.testnet", NEAR / 100).set_release_rules(None)), "E_NO_PLAN");
    assert_eq!(panic_code(|| e.as_("d1.testnet", NEAR / 100).set_checkin_delegates(vec![acc("d3.testnet")])), "E_NO_PLAN");
    // A delegate's set_plan writes a plan of its own, never the owner's.
    e.as_("d1.testnet", NEAR).set_plan(plan_input());
    assert_eq!(e.plan().version, 1);
    // While a release is open a delegate can't check in, so it can't cancel it.
    e.advance(97 * DAY);
    let id = e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), None, None, None);
    e.as_("g2.testnet", 0).approve_release(acc("owner.testnet"), id);
    assert_eq!(panic_code(|| e.as_("d1.testnet", 0).check_in(Some(acc("owner.testnet")))), "E_PROPOSAL_OPEN");
    assert_eq!(e.status(), PlanStatus::Waiting);
    // Delegates are frozen with the rest of the plan.
    assert_eq!(panic_code(|| e.as_("owner.testnet", NEAR / 100).set_checkin_delegates(vec![])), "E_PROPOSAL_OPEN");
    // The owner still can.
    e.as_("owner.testnet", 0).check_in(None);
    assert_eq!(e.status(), PlanStatus::Active);
}

#[test]
fn removed_delegates_lose_the_right() {
    let mut e = delegated();
    e.as_("owner.testnet", 0).set_checkin_delegates(vec![acc("d2.testnet")]);
    assert_eq!(panic_code(|| e.as_("d1.testnet", 0).check_in(Some(acc("owner.testnet")))), "E_NOT_DELEGATE");
    e.as_("d2.testnet", 0).check_in(Some(acc("owner.testnet")));
    e.as_("owner.testnet", 0).set_checkin_delegates(vec![]);
    assert!(e.as_("x.testnet", 0).get_checkin_delegates(acc("owner.testnet")).is_empty());
    assert_eq!(panic_code(|| e.as_("d2.testnet", 0).check_in(Some(acc("owner.testnet")))), "E_NOT_DELEGATE");
}

#[test]
fn delegate_lists_are_checked() {
    let mut e = delegated();
    let eleven: Vec<AccountId> = (0..11).map(|i| acc(&format!("d{i}.testnet"))).collect();
    assert_eq!(panic_code(|| e.as_("owner.testnet", NEAR / 100).set_checkin_delegates(eleven)), "E_INVALID_DELEGATES");
    assert_eq!(panic_code(|| e.as_("owner.testnet", NEAR / 100).set_checkin_delegates(vec![acc("d1.testnet"), acc("d1.testnet")])), "E_INVALID_DELEGATES");
    assert_eq!(panic_code(|| e.as_("owner.testnet", NEAR / 100).set_checkin_delegates(vec![acc("owner.testnet")])), "E_INVALID_DELEGATES");
    assert_eq!(panic_code(|| e.as_("nobody.testnet", NEAR / 100).set_checkin_delegates(vec![acc("d1.testnet")])), "E_NO_PLAN");
}

#[test]
fn delegates_are_a_standard_feature() {
    let mut e = Env::new().with_tiers();
    e.as_("owner.testnet", NEAR).set_plan(free_plan());
    assert_eq!(panic_code(|| e.as_("owner.testnet", NEAR / 100).set_checkin_delegates(vec![acc("d1.testnet")])), "E_TIER_REQUIRED");
    e.pay("owner.testnet", "owner.testnet", 49 * DOLLAR);
    e.as_("owner.testnet", NEAR / 100).set_checkin_delegates(vec![acc("d1.testnet")]);
    let t = e.tier("owner.testnet");
    assert_eq!(t.required, 1);
    assert!(t.features.unwrap().checkin_delegates);
    assert_eq!(e.as_("x.testnet", 0).required_tier(free_plan(), None, None, None, None), 0);
}

#[test]
fn a_schedule_stored_before_delegates_still_reads() {
    let mut e = Env::new();
    e.as_("anyone.testnet", 0);
    // The D25 layout, as the deployed contract wrote it.
    #[near(serializers = [borsh])]
    struct SpecV1 {
        name: String,
        price: U128,
        max_heirs: u8,
        max_guardians: u8,
        external_assets: bool,
        release_rules: bool,
        advanced_release: bool,
    }
    #[near(serializers = [borsh])]
    struct CfgV1 {
        fee_token: Option<AccountId>,
        fee_symbol: String,
        fee_decimals: u8,
        tiers: Vec<SpecV1>,
    }
    let old = CfgV1 {
        fee_token: Some(acc(USDC)),
        fee_symbol: "USDC".into(),
        fee_decimals: 6,
        tiers: tiers::default_tiers(6)
            .into_iter()
            .map(|t| SpecV1 { name: t.name, price: t.price, max_heirs: t.max_heirs, max_guardians: t.max_guardians, external_assets: t.external_assets, release_rules: t.release_rules, advanced_release: t.advanced_release })
            .collect(),
    };
    env::storage_write(b"tier_cfg", &near_sdk::borsh::to_vec(&old).unwrap());
    let cfg = e.as_("x.testnet", 0).get_tier_config();
    assert_eq!(cfg.fee_token, Some(acc(USDC)), "tiers stay on after the upgrade");
    assert_eq!(cfg.tiers.iter().map(|t| t.delegates_allowed()).collect::<Vec<_>>(), vec![false, true, true]);
    // The next admin write moves it to the new key.
    e.as_("admin.testnet", 0).set_tier_config(cfg.clone());
    assert!(!env::storage_has_key(b"tier_cfg"));
    assert_eq!(e.as_("x.testnet", 0).get_tier_config(), cfg);
}

#[test]
fn every_payable_call_works_from_a_dao_proposal() {
    // A DAO proposal runs as the DAO (predecessor) in a transaction a council
    // member signed, with the deposit taken from the DAO's balance.
    let mut e = Env::new().with_executor().with_tiers();
    e.as_("admin.testnet", REG).set_nep141_tokens(vec![Nep141Token { account_id: acc(WNEAR), symbol: "wNEAR".into(), decimals: 24, storage_deposit: U128(REG) }]);
    // Its tier, paid by the DAO itself with ft_transfer_call.
    e.pay(DAO, DAO, 149 * DOLLAR);
    assert_eq!(e.tier(DAO).tier, 2);
    e.via(DAO, COUNCIL, NEAR).set_plan(plan_input());
    e.via(DAO, COUNCIL, 2 * NEAR).deposit(acc(DAO));
    e.via(DAO, COUNCIL, NEAR / 100).set_release_rules(Some(rules()));
    e.via(DAO, COUNCIL, NEAR / 100).set_release_options(Some(opts(ReleaseMode::Hybrid)));
    e.via(DAO, COUNCIL, NEAR / 100).set_btc_destinations(vec![BtcDestination { account_id: acc("amara.testnet"), address: "tb1p5e6v9v2j5wp3y6c79gaqdqltq7jdv45fswnnm7exmmp2020mqepsvssqqw".into() }]);
    e.via(DAO, COUNCIL, NEAR / 100).set_checkin_delegates(vec![acc(COUNCIL)]);
    e.via(DAO, COUNCIL, NEAR).fund_sponsor_pool();
    assert_eq!(ft_deposit(&mut e, WNEAR, DAO, 1_000, ""), 0, "token escrow by the DAO");
    let v = e.as_("x.testnet", 0).get_plan(acc(DAO)).unwrap();
    assert_eq!(v.plan.escrow.0, 2 * NEAR);
    // Without a deposit, a council member's transaction isn't sponsored storage.
    e.sponsor(NEAR);
    let c = e.via("other.sputnikv2.testnet", COUNCIL, 0);
    assert_eq!(panic_code(move || c.set_plan(free_plan())), "E_INSUFFICIENT_DEPOSIT");
    // The council member who signed is never the owner.
    let c = e.via(COUNCIL, COUNCIL, 0);
    assert_eq!(panic_code(move || c.withdraw(U128(1))), "E_NO_PLAN");
    // A council member as delegate keeps the DAO's plan alive between votes.
    e.advance(96 * DAY);
    e.via(COUNCIL, COUNCIL, 0).check_in(Some(acc(DAO)));
    assert_eq!(e.as_("x.testnet", 0).get_plan(acc(DAO)).unwrap().status, PlanStatus::Active);
}

/// Owner plan with a DAO guardian (quorum 2 with g1) and a DAO heir in Automatic mode.
fn dao_roles() -> Env {
    let mut e = Env::new().with_executor();
    let mut p = plan_input();
    p.guardians = vec![acc(GUARD_DAO), acc("g1.testnet"), acc("g2.testnet")];
    p.heirs[1] = HeirInput { account_id: acc(HEIR_DAO), share_bps: 4000, near_destination: Some(acc(HEIR_DAO)), eth_destination: None };
    e.as_("owner.testnet", NEAR).set_plan(p);
    let mut o = opts(ReleaseMode::Automatic);
    o.delay_signers = vec![acc(GUARD_DAO), acc("d1.testnet")];
    o.delay_quorum = 1;
    e.as_("owner.testnet", NEAR / 100).set_release_options(Some(o));
    e.as_("owner.testnet", 10 * NEAR).deposit(acc("owner.testnet"));
    e.advance(97 * DAY);
    e
}

#[test]
fn a_dao_guardian_proposes_and_approves() {
    let mut e = dao_roles();
    let id = e.via(GUARD_DAO, COUNCIL, 0).propose_release(acc("owner.testnet"), None, None, None);
    assert_eq!(e.plan().proposal.unwrap().proposer, acc(GUARD_DAO));
    // The council member who signed has no role of their own.
    let c = e.via(COUNCIL, COUNCIL, 0);
    assert_eq!(panic_code(move || c.approve_release(acc("owner.testnet"), id)), "E_NOT_GUARDIAN");
    e.via("g1.testnet", "g1.testnet", 0).approve_release(acc("owner.testnet"), id);
    assert_eq!(e.status(), PlanStatus::Waiting);
}

#[test]
fn a_dao_delay_signer_extends() {
    let mut e = dao_roles();
    let id = e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), None, None, None);
    e.via(GUARD_DAO, COUNCIL, 0).approve_release(acc("owner.testnet"), id);
    let before = ends(&mut e);
    e.via(GUARD_DAO, COUNCIL, 0).request_extension(acc("owner.testnet"), id, 10 * DAY, Some("dao-vote-pending".into()));
    assert_eq!(ends(&mut e), before + 10 * DAY);
}

#[test]
fn a_dao_heir_is_paid_automatically_and_can_claim() {
    let mut e = dao_roles();
    let id = e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), None, None, None);
    e.as_("g2.testnet", 0).approve_release(acc("owner.testnet"), id);
    e.advance(30 * DAY);
    // Automatic: nobody at the DAO signs anything; the executor starts it.
    assert_eq!(e.as_("exec.testnet", 0).release(acc("owner.testnet"), acc(HEIR_DAO)), 1);
    let t = e.plan().proposal.unwrap().transfers.into_iter().find(|t| t.heir == acc(HEIR_DAO)).unwrap();
    assert_eq!((t.destination.as_str(), t.amount.0, t.state), (HEIR_DAO, 4 * NEAR, TransferState::Sending));
    // In Claim mode the DAO claims through a proposal like any other call.
    let mut e = dao_roles();
    e.as_("owner.testnet", 0).set_release_options(None);
    let id = e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), None, None, None);
    e.as_("g2.testnet", 0).approve_release(acc("owner.testnet"), id);
    e.advance(30 * DAY);
    assert_eq!(e.via(HEIR_DAO, COUNCIL, 0).claim(acc("owner.testnet")), 1);
}
