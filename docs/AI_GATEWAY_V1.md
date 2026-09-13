# Toking AI Gateway V1

## Goal

Expose an OpenAI-compatible API backed by multiple upstream AI providers while
charging the authoritative Toking Credit Service. Gangram is the first provider.
The gateway owns no wallet or ledger data and never connects to the Credit
Service database.

## Request flow

1. A client sends `POST /v1/chat/completions` with a `tk_live_...` bearer key and
   a provider-prefixed model ID returned by `GET /v1/models`.
2. Toking validates the API key and resolves the model through its provider
   registry.
3. The gateway creates a fixed, configurable Credit Service reservation.
4. The selected adapter sends the request to that provider with a distinct
   provider credential and the unprefixed model ID.
5. Toking captures reported USD cost, reported tokens, or an estimated fallback.
6. The reservation is released when the provider fails before producing output.

`CREDITS_PER_USD=100` converts provider-reported USD cost to integer Toking Credits: 10,000 Credits = $100. Set it in the gateway environment and restart the gateway to apply changes. Each request rounds its charge up to a whole Credit ($0.01).

`DEFAULT_RESERVATION_CREDITS=1` holds one Credit per request; `FALLBACK_CREDITS_PER_TOKEN=0.0001` scales unpriced token estimates to this denomination. Unverified charges are capped at the reserved amount. Rate changes apply to new requests; existing balances and ledger entries are not converted.
`DEFAULT_RESERVATION_CREDITS` controls the initial hold and does not cap the final
charge.
Capture uses a stable idempotency key and is retried up to three times. Captures
may exceed the original reservation and leave a negative account balance.

For streams, the gateway passes valid server-sent events through and holds the
final `[DONE]` until capture succeeds. It estimates usage while output is in
flight and aborts a provider stream if the estimate exceeds spendable credit.
These estimates are approximate and are not a strict monetary spending cap.
Authoritative reconciliation after interrupted streams remains future work.

## Endpoints

- `GET /health`
- `GET /v1/models` (customer keys)
- `POST /v1/chat/completions`

See [AI_PROVIDER_CONTRACT_V1.md](AI_PROVIDER_CONTRACT_V1.md) for the upstream
contract, public model-ID format, failure behavior, and Gangram checklist.

## Deferred

- Responses API, embeddings, images, audio, and legacy completions
- Native adapters for providers that are not OpenAI-compatible
- Automatic fallback, inference retries, and provider load balancing
- Model-specific reservation estimates and Toking retail pricing
- Durable capture outbox and delayed provider usage reconciliation
