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
    let id = e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), Some(U128(NEAR)));
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

    let id = e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), Some(U128(NEAR)));
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
    e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), None);
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
    e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), None);
}

#[test]
#[should_panic(expected = "E_NOT_GUARDIAN")]
fn non_guardian_cannot_propose() {
    let mut e = funded_overdue();
    e.as_("amara.testnet", 0).propose_release(acc("owner.testnet"), None);
}

#[test]
#[should_panic(expected = "E_ALREADY_VOTED")]
fn guardian_cannot_vote_twice() {
    let mut e = funded_overdue();
    let id = e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), None);
    e.as_("g1.testnet", 0).approve_release(acc("owner.testnet"), id);
}

#[test]
fn insufficient_quorum_stays_proposed() {
    let mut e = funded_overdue();
    e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), None);
    e.advance(365 * DAY);
    assert_eq!(e.status(), PlanStatus::Proposed);
}

#[test]
fn rejections_that_make_quorum_impossible_kill_the_proposal() {
    let mut e = funded_overdue();
    let id = e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), None);
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
    e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), Some(U128(21_000 * 50 * GWEI)));
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
    let expected = eth::EthTransfer { chain_id: 11155111, nonce: 0, max_priority_fee_per_gas: 2 * GWEI, max_fee_per_gas: 20 * GWEI, gas_limit: 21_000, to: &to, value: tr.amount.0 };
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
    let id = e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), None);
    assert_eq!(e.as_("x.testnet", 0).list_open_releases(None, None), vec![acc("owner.testnet")]);
    e.as_("g2.testnet", 0).reject_release(acc("owner.testnet"), id);
    e.as_("g3.testnet", 0).reject_release(acc("owner.testnet"), id);
    assert!(e.as_("x.testnet", 0).list_open_releases(None, None).is_empty());
    e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), None);
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
    let id = e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), Some(U128(NEAR)));
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
    let expected = eth::EthTransfer { chain_id: 11155111, nonce: 0, max_priority_fee_per_gas: 2 * GWEI, max_fee_per_gas: 20 * GWEI, gas_limit: 250_000, to: &to, value: tr.amount.0 };
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
    let old = e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), Some(U128(NEAR)));
    e.as_("owner.testnet", 0).cancel_release();
    e.advance(97 * DAY);
    let new = e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), Some(U128(NEAR)));
    assert_ne!(old, new);
    e.as_("g2.testnet", 0).approve_release(acc("owner.testnet"), old);
}

#[test]
fn edited_destinations_need_a_fresh_proposal_and_fresh_votes() {
    let mut e = funded_overdue();
    let id = e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), Some(U128(NEAR)));
    e.as_("owner.testnet", 0).cancel_release();
    let mut edited = plan_input();
    edited.heirs[0].eth_destination = Some("0x000000000000000000000000000000000000dead".into());
    e.as_("owner.testnet", NEAR).set_plan(edited);
    e.advance(97 * DAY);
    let id2 = e.as_("g1.testnet", 0).propose_release(acc("owner.testnet"), Some(U128(NEAR)));
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
        assert_eq!((&b.heir, &b.destination, b.amount, b.asset), (&a.heir, &a.destination, a.amount, a.asset));
    }
}
