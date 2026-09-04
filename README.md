# Toking

Toking is being built as two services:

- **Credit Service**: identity, gift cards, Credit Accounts, wallets, API keys,
  ledger, reservations, and capture.
- **AI Gateway**: the OpenAI-compatible gateway that routes requests to AI
  providers and charges the Credit Service.

The Credit Service is implemented first. See
[`docs/CREDIT_SERVICE_V1_PLAN.md`](docs/CREDIT_SERVICE_V1_PLAN.md) for the
decisions and invariants.

## Current implementation

`apps/credit-api` and `apps/admin-web` currently provide:

- Development phone OTP and user sessions
- Single-password admin sessions
- Integration clients and scoped client API keys
- Gift-card batches and secure one-time code generation
- Anonymous redemption into an anonymous Credit Account
- Authenticated redemption into a user's wallet
- Toking Gateway API-key issuance
- Encrypted idempotent replay of redemption responses
- Immutable, database-guarded double-entry journals
- Reserve, capture, release, expiry, and lookup
- Capture above reservation and signed/negative wallet balances
- Integration tests against PostgreSQL
- A local admin dashboard for gift-card issuance, integration credentials,
  anonymous redemption testing, account balances, and audit activity

`apps/ai-gateway` provides a multi-provider gateway, with Gangram as the first provider:

- OpenAI-compatible `GET /v1/models` and `POST /v1/chat/completions`
- Non-streaming and server-sent-event streaming responses
- Credit reservation before the provider call
- Provider registry and provider-prefixed model routing
- Provider-attributed capture with configurable Credit conversion
- Over-capture into negative balances
- Reservation release on upstream failure
- Estimated streaming cutoff when spendable credit is exhausted
- OpenAI-compatible error bodies

## Requirements

- Node.js 22 or newer
- PostgreSQL 16 or newer

## Local setup

Install dependencies:

```sh
npm install
```

Create the database if it does not already exist:

```sh
createdb -h 127.0.0.1 -p 5432 toking
```

Copy the environment template and replace the development secrets:

```sh
cp apps/credit-api/.env.example apps/credit-api/.env
```

Apply migrations from the repository root:

```sh
npm run db:migrate
```

Run the Credit API:

```sh
npm run dev:credit
```

The default development address is `http://127.0.0.1:3100`.

In a second terminal, run the admin dashboard:

```sh
npm run dev:admin
```

Open `http://localhost:3000` and sign in with the development admin password.

Copy the gateway environment template and configure the Gangram provider URL and API key:

```sh
cp apps/ai-gateway/.env.example apps/ai-gateway/.env
```

Run the AI Gateway:

```sh
npm run dev:gateway
```

Its development address is `http://127.0.0.1:3200`. Use
`http://127.0.0.1:3200/v1` as the OpenAI-compatible base URL and a `tk_live_...`
key returned by gift-card redemption. See
[`docs/AI_GATEWAY_V1.md`](docs/AI_GATEWAY_V1.md) for the request and charging
flow, and [`docs/AI_PROVIDER_CONTRACT_V1.md`](docs/AI_PROVIDER_CONTRACT_V1.md)
for upstream provider integration.

Third-party gift-card storefronts should follow
[`docs/THIRD_PARTY_GIFT_CARD_INTEGRATION.md`](docs/THIRD_PARTY_GIFT_CARD_INTEGRATION.md)
for scoped catalog access, anonymous redemption, and customer credential delivery.

The gateway example configuration uses a placeholder local Gangram endpoint.
Gangram must supply its real base URL and credential before live inference can
run. Clients discover models with `GET /v1/models` and use returned IDs such as
`gangram/vendor/model-name` in chat requests. The old single-provider environment
settings are replaced by the `AI_PROVIDERS` registry.

Run one reservation-expiry worker pass:

```sh
npm run worker:credit
```

## Verification

```sh
npm run typecheck
npm run build
npm test
```

The integration test covers both redemption modes, safe retry of anonymous
redemption, over-capture into a negative balance, refusal of the next reserve,
phone login, ledger balance, and database-level ledger immutability.

## Development credentials

Development defaults are intentionally simple:

- Admin password: `development-admin`
- OTP: `123456`

New gift-card codes start with `TK` followed by 14 random uppercase letters and
digits (16 characters total, without separators). Previously issued codes remain
redeemable.

Production startup rejects the built-in development secrets. Raw gift-card
codes and API keys are returned only when created. The one exception is a retry
with the same redemption idempotency key: the response is encrypted at rest and
replayed so a network failure does not lose the newly issued API key.

## Public API groups

- `/v1/auth/*`: user OTP and sessions
- `/v1/wallet*`: authenticated user wallet queries
- `/v1/gift-cards/*`: authenticated user redemption
- `/v1/client/*`: scoped third-party redemption
- `/v1/admin/*`: V1 administration
- `/internal/v1/*`: future AI Gateway charging contract

All external economic mutations require an `Idempotency-Key` header. Credit
amounts are serialized as decimal strings to preserve 64-bit integer precision.
