# Toking Credit Service V1

## Goal

Build the authoritative identity, gift-card, credit-account, wallet, API-key,
ledger, and charging service used by the future Toking AI Gateway.

The Credit Service never calls an AI provider. The future AI Gateway owns
OpenAI-compatible APIs, provider routing, streaming, model pricing, and usage
calculation.

## V1 product rules

- Credits are positive integer units. Monetary sale price is out of scope.
- Gift cards are single-use and store only a secure hash of the raw code.
- A gift card can be redeemed either anonymously or by an authenticated user.
- Anonymous redemption creates a separate anonymous Credit Account and Toking
  API key. Anonymous accounts cannot be combined or claimed in V1.
- Authenticated redemption credits the user's single existing Credit Account.
- A Toking API key points to a Credit Account, not an AI provider.
- Changing the selected provider never changes the Toking API key or gateway
  base URL.
- Reservations require sufficient available balance.
- Capture must reference an active reservation, may exceed the reserved amount,
  and may make the posted balance negative.
- A Credit Account with available balance less than or equal to zero cannot
  create a new reservation.
- Refunds, settlement, account linking, anonymous-account claiming, negative
  exposure limits, and card payments are out of scope.

## Service boundary

### Credit Service owns

- Phone identity and OTP sessions
- Integration clients and client API keys
- User and anonymous Credit Accounts
- Gift-card batches, cards, and redemption
- Toking Gateway API keys
- Wallet projections and immutable double-entry ledger
- Reservations, capture, release, and expiry
- Provider selection identifiers
- Admin authentication and audit events

### AI Gateway owns later

- OpenAI-compatible endpoints
- AI-provider credentials and adapters
- Provider/model routing
- Streaming and usage normalization
- Pricing and conversion of usage into integer Toking Credits
- Durable retries of capture calls

## Financial invariants

1. Every posted journal contains at least two entries whose signed amounts sum
   to zero.
2. Posted journals and entries are append-only.
3. Each Credit Account has exactly one wallet ledger account.
4. `available_balance = posted_balance - reserved_balance`.
5. Gift-card redemption, journal posting, wallet projection update, and card
   consumption commit in one database transaction.
6. Reservation creation locks the Credit Account and cannot over-reserve the
   current available balance.
7. Capture locks both reservation and Credit Account, releases the entire hold,
   posts the actual charge, and is safe to retry.
8. All externally initiated mutations require an idempotency key.

## Delivery sequence

1. PostgreSQL schema and migrations.
2. Ledger and Credit Account services with invariant tests.
3. Gift-card batch generation and atomic redemption.
4. Client credentials, phone OTP, sessions, and Toking API keys.
5. Reservation, capture, release, expiry, and lookup APIs.
6. Admin APIs and audit records.
7. Admin web dashboard.
8. AI Gateway contract tests and implementation.

## Initial API surface

### Health

- `GET /health`

### User identity and wallet

- `POST /v1/auth/otp/request`
- `POST /v1/auth/otp/verify`
- `POST /v1/auth/logout`
- `GET /v1/wallet`
- `GET /v1/wallet/transactions`
- `POST /v1/gift-cards/redeem`

### Third-party redemption

- `POST /v1/client/gift-cards/redeem-anonymously`
- Client API-key scope: `gift-cards:redeem-anonymously`

### Admin

- `POST /v1/admin/login`
- `POST /v1/admin/clients`
- `POST /v1/admin/clients/:id/api-keys`
- `POST /v1/admin/gift-card-batches`
- `POST /v1/admin/gift-card-batches/:id/cards`

### Internal AI Gateway contract

- `POST /internal/v1/reservations`
- `POST /internal/v1/reservations/:id/capture`
- `POST /internal/v1/reservations/:id/release`
- `GET /internal/v1/reservations/:id`

## Implementation defaults

- Node.js and TypeScript
- Fastify
- PostgreSQL
- Drizzle ORM with explicit SQL migrations
- Zod request and environment validation
- PostgreSQL-backed worker jobs; no broker required for V1
- One monorepo with independently deployable applications
