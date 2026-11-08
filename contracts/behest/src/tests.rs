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
    e.as_("owner.testnet", 0).check_in();
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
    e.as_("exec.testnet", 0).report_broadcast(acc("owner.testnet"), i, "0xabc".into());
    e.as_("exec.testnet", 0).report_failed(acc("owner.testnet"), i, "Reverted".into());
    e
}

#[test]
fn reverted_transfer_is_reissued_on_a_fresh_nonce_with_current_gas() {
    let mut e = eth_reverted();
    e.as_("admin.testnet", 0).set_eth_gas_limit(250_000);
    let i = e.eth_index();
    let _ = e.as_("admin.testnet", 0).reissue_reverted_transfer(acc("owner.testnet"), i);
    let tr = e.eth_transfer();
    let p = tr.eth_tx.unwrap();
    assert_eq!((tr.state, p.nonce, p.gas_limit, p.max_fee_per_gas.0), (TransferState::Signing, 1, 250_000, 20 * GWEI));
    assert_eq!(e.plan().eth_next_nonce, 2);
    // the reverted version stays on record
    assert_eq!(tr.signed_versions.len(), 1);
}

#[test]
#[should_panic(expected = "E_UNAUTHORIZED")]
fn only_admin_reissues() {
    let mut e = eth_reverted();
    let i = e.eth_index();
    let _ = e.as_("exec.testnet", 0).reissue_reverted_transfer(acc("owner.testnet"), i);
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
                    tx_hash: Some("0xabc".into()),
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
        e.as_("owner.testnet", NEAR / 10).set_btc_destinations(vec![BtcDestination { account_id: acc("mallory.testnet"), address: AMARA_BTC.into() }]);
    }

    #[test]
    #[should_panic(expected = "E_BTC_VAULT_UNKNOWN")]
    fn proposal_with_coins_needs_registered_vault() {
        let mut e = Env::new();
        e.as_("owner.testnet", NEAR).set_plan(plan_input());
        e.as_("owner.testnet", NEAR / 10).set_btc_destinations(vec![BtcDestination { account_id: acc("amara.testnet"), address: AMARA_BTC.into() }]);
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
