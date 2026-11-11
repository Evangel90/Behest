//! Testnet-only stand-in for the NEAR Intents verifier (`intents.near`), so
//! Behest's Intents delivery (D27) can run end to end on testnet. It does the
//! parts Behest and the heir screen touch, and nothing else:
//!
//! - `ft_on_transfer(sender_id, amount, msg)`: msg is `{"receiver_id": …}`
//!   (or a bare account id, as the real verifier accepts); the token is
//!   credited to that account as `nep141:<token>`. It hands back
//!   `refund_bps` of each deposit (0 by default), or panics when `fail` is
//!   set, so refunds and failures can be tested live.
//! - `mt_balance_of`, `mt_batch_balance_of`: balances by token id, as the
//!   real verifier names them.
//! - `ft_withdraw(token, receiver_id, amount)`: the holder takes tokens out
//!   (1 yoctoNEAR attached, re-credited if the transfer fails).
//!
//! There are no intents, signatures, swaps or solvers here: the real verifier
//! and 1Click stay untested until a mainnet step.
use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    balances: LookupMap<String, u128>,
    refund_bps: u16,
    fail: bool,
}

#[near(serializers = [json])]
pub struct Behaviour {
    pub refund_bps: u16,
    pub fail: bool,
}

#[near(serializers = [json])]
#[serde(untagged)]
enum DepositMsg {
    Json { receiver_id: AccountId },
    Account(AccountId),
}

const FT_GAS: Gas = Gas::from_tgas(15);
const CALLBACK_GAS: Gas = Gas::from_tgas(5);

fn key(account: &AccountId, token_id: &str) -> String {
    format!("{account}|{token_id}")
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self { owner, balances: LookupMap::new(b"b".to_vec()), refund_bps: 0, fail: false }
    }

    /// Test control (owner only): hand back `refund_bps` of each deposit, or fail every deposit.
    pub fn set_behaviour(&mut self, refund_bps: u16, fail: bool) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        require!(refund_bps <= 10_000, "refund_bps is at most 10000");
        self.refund_bps = refund_bps;
        self.fail = fail;
    }

    pub fn get_behaviour(&self) -> Behaviour {
        Behaviour { refund_bps: self.refund_bps, fail: self.fail }
    }

    /// NEP-141 receiver: credits the deposit inside "Intents" and returns what it hands back.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        require!(!self.fail, "mock verifier: deposits are failing");
        let receiver = match near_sdk::serde_json::from_str::<DepositMsg>(&msg) {
            Ok(DepositMsg::Json { receiver_id }) | Ok(DepositMsg::Account(receiver_id)) => receiver_id,
            Err(_) if msg.is_empty() => sender_id.clone(),
            Err(_) => msg.parse().unwrap_or_else(|_| env::panic_str("msg must name a receiver_id")),
        };
        let refund = amount.0 * self.refund_bps as u128 / 10_000;
        let kept = amount.0 - refund;
        let token_id = format!("nep141:{}", env::predecessor_account_id());
        let k = key(&receiver, &token_id);
        let cur = self.balances.get(&k).copied().unwrap_or(0);
        self.balances.insert(k, cur + kept);
        env::log_str(&format!("mock-intents: {receiver} +{kept} {token_id} (from {sender_id}, refunded {refund})"));
        PromiseOrValue::Value(U128(refund))
    }

    pub fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128 {
        U128(self.balances.get(&key(&account_id, &token_id)).copied().unwrap_or(0))
    }

    pub fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<String>) -> Vec<U128> {
        token_ids.iter().map(|t| U128(self.balances.get(&key(&account_id, t)).copied().unwrap_or(0))).collect()
    }

    /// The holder withdraws `amount` of `token` to `receiver_id` on NEAR.
    #[payable]
    pub fn ft_withdraw(&mut self, token: AccountId, receiver_id: AccountId, amount: U128, memo: Option<String>) -> Promise {
        require!(env::attached_deposit() == NearToken::from_yoctonear(1), "attach exactly 1 yoctoNEAR");
        let holder = env::predecessor_account_id();
        let token_id = format!("nep141:{token}");
        let k = key(&holder, &token_id);
        let cur = self.balances.get(&k).copied().unwrap_or(0);
        require!(amount.0 > 0 && cur >= amount.0, "not enough balance");
        self.balances.insert(k, cur - amount.0);
        Promise::new(token)
            .function_call(
                "ft_transfer",
                near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({"receiver_id": receiver_id, "amount": amount, "memo": memo})).unwrap(),
                NearToken::from_yoctonear(1),
                FT_GAS,
            )
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_withdraw(holder, token_id, amount))
    }

    #[private]
    pub fn on_withdraw(&mut self, holder: AccountId, token_id: String, amount: U128) -> bool {
        let ok = env::promise_result_checked(0, 0).is_ok();
        if !ok {
            let k = key(&holder, &token_id);
            let cur = self.balances.get(&k).copied().unwrap_or(0);
            self.balances.insert(k, cur + amount.0);
        }
        ok
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }
    fn as_(who: &str) {
        testing_env!(VMContextBuilder::new().predecessor_account_id(acc(who)).build());
    }
    fn deposit(c: &mut Contract, token: &str, amount: u128, msg: &str) -> u128 {
        as_(token);
        match c.ft_on_transfer(acc("behest.testnet"), U128(amount), msg.into()) {
            PromiseOrValue::Value(v) => v.0,
            _ => unreachable!(),
        }
    }

    #[test]
    fn credits_the_receiver_and_refunds_as_configured() {
        as_("admin.testnet");
        let mut c = Contract::new(acc("admin.testnet"));
        assert_eq!(deposit(&mut c, "wrap.testnet", 100, r#"{"receiver_id":"amara.testnet"}"#), 0);
        assert_eq!(deposit(&mut c, "wrap.testnet", 50, "amara.testnet"), 0);
        assert_eq!(c.mt_balance_of(acc("amara.testnet"), "nep141:wrap.testnet".into()).0, 150);
        as_("admin.testnet");
        c.set_behaviour(2500, false);
        assert_eq!(deposit(&mut c, "usdt.testnet", 100, r#"{"receiver_id":"0x71c7656ec7ab88b098defb751b7401b5f6d8976f"}"#), 25);
        assert_eq!(c.mt_batch_balance_of(acc("0x71c7656ec7ab88b098defb751b7401b5f6d8976f"), vec!["nep141:usdt.testnet".into(), "nep141:wrap.testnet".into()]).iter().map(|u| u.0).collect::<Vec<_>>(), vec![75, 0]);
        as_("admin.testnet");
        c.set_behaviour(10_000, false);
        assert_eq!(deposit(&mut c, "wrap.testnet", 10, "amara.testnet"), 10);
    }

    #[test]
    #[should_panic(expected = "deposits are failing")]
    fn can_fail_every_deposit() {
        as_("admin.testnet");
        let mut c = Contract::new(acc("admin.testnet"));
        c.set_behaviour(0, true);
        deposit(&mut c, "wrap.testnet", 1, "amara.testnet");
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn only_the_owner_sets_behaviour() {
        as_("admin.testnet");
        let mut c = Contract::new(acc("admin.testnet"));
        as_("x.testnet");
        c.set_behaviour(1, false);
    }
}
