# Tokard integration verification — 2026-09-05

## Result

Local backend flow verified. Production flow is not yet verified.

- Existing suite: 36 tests passed (26 gateway/provider, 10 credit/request parsing).
- Added combined storefront flow: 3 tests passed.
- Workspace type checks passed.

The combined test runs the actual Credit API, Gateway and PostgreSQL ledger. Requests between services use an in-process transport; only the upstream AI catalog and completion are simulated. It does not test production networking, real inference, or the Tokard UI.

## Verified behavior

1. A dedicated test card redeems for 10,000 credits and returns a customer key and correctly formed gateway URLs.
2. Whitespace/case normalization works. Replaying the original idempotency key returns the identical redemption response and does not duplicate credit.
3. The customer key lists provider-prefixed model IDs; listing does not change the balance.
4. Completing with a returned model ID routes correctly and charges 1 credit for simulated usage at an explicitly configured 100 credits per USD. The real account balance becomes 9,999 and its reserved balance returns to zero.
5. Invalid cards, reused cards, conflicting idempotency keys and wrong credential types are rejected.
6. A catalog failure preserves the credited account; retry succeeds without another redemption.
7. An upstream completion failure is normalized to HTTP 502 and releases the reservation without charging.

Test source: `apps/credit-api/test/storefront-flow.test.ts`.

Dedicated local test records remain in the local database for audit. No application behavior was changed by this test work.

## Production observations and remaining work

- `https://credit.tokim.ai/health`: HTTP 200, Credit API healthy.
- `https://api.tokim.ai/health`: HTTP 200, gateway healthy, Gangram configured. This does not prove upstream inference works.
- The user signed into `https://admin.tokim.ai/` successfully. Its UI displays development/localhost labels, so the actual API destination still needs verification before production mutations.
- Automatic approval review blocked creating a production test-card batch. No production card was issued or redeemed by this run.

Pending explicit approval: create one dedicated 10,000-credit smoke-test card and a scoped test integration credential; redeem through the production Credit API; replay the same attempt; fetch actual models; send one small completion using a returned model (maximum 32 output tokens); verify the resulting balance and reservations. Keep credentials out of the report. Confirm the destination before issuing test data.

The Tokard success-page rendering, copy/save actions and model-loading recovery require separate browser verification after Manus implements the integration.

## Commit preparation — 2026-09-14

The storefront test explicitly sets its credit conversion to 100 credits per USD, matching its current balance expectations independently of gateway defaults. The September 5 run used the previous conversion and charged 7 credits; production observations above are historical.
