# Third-party gift-card seller integration

This guide is for a storefront that redeems a purchased Toking gift card and
then displays the AI models available to the purchaser.

## Credentials and service addresses

Toking creates an integration client for the seller and issues a `tci_live_...`
client API key with the `gift-cards:redeem-anonymously` scope. Keep this key on
the seller's server. Do not put it in browser JavaScript, a mobile app,
analytics, URLs, or logs. Toking displays it only when it is created.

The production service addresses are:

- Credit API: `https://credit.tokim.ai`
- AI Gateway base URL: `https://api.tokim.ai/v1`
- Toking admin dashboard: `https://admin.tokim.ai`

The root domain `https://tokim.ai` can host the public website. TLS should be
enabled for every public hostname.

## Toking deployment configuration

Set these values on the Credit API:

```dotenv
NODE_ENV=production
TOKING_GATEWAY_BASE_URL=https://api.tokim.ai/v1
CORS_ORIGINS=https://admin.tokim.ai
```

Set the admin web application value at build/deployment time:

```dotenv
NEXT_PUBLIC_CREDIT_API_URL=https://credit.tokim.ai
```

The AI Gateway should use the Credit API's private network address when both
services run on the same server or private container network:

```dotenv
NODE_ENV=production
CREDIT_SERVICE_BASE_URL=http://credit-api:3100
```

`INTERNAL_SERVICE_SECRET` must have the same strong value on the Credit API and
AI Gateway. Do not route the private container address through public DNS. Map
public traffic for `api.tokim.ai` to the AI Gateway and `credit.tokim.ai` to the
Credit API with the server's reverse proxy.

## Generate a seller API key

### Using the admin dashboard

1. Open `https://admin.tokim.ai` and sign in with the configured admin password.
2. Open **Integrations**.
3. Create an integration using the seller's business or platform name.
4. Select **Create key** for that integration.
5. Copy the returned `tci_live_...` key immediately and transfer it to the
   seller through an approved secret-sharing channel. The raw key is shown only
   once.

The dashboard creates the key with the
`gift-cards:redeem-anonymously` scope. Each seller should receive a separate
integration and key so it can be audited or revoked independently.

### Using the admin API

First sign in. Replace the example password and copy `token` from the response:

```http
POST /v1/admin/login HTTP/1.1
Host: credit.tokim.ai
Content-Type: application/json

{"password":"YOUR_PRODUCTION_ADMIN_PASSWORD"}
```

Create the seller and copy its returned `id`:

```http
POST /v1/admin/clients HTTP/1.1
Host: credit.tokim.ai
Authorization: Bearer ADMIN_SESSION_TOKEN
Content-Type: application/json

{"name":"Seller Platform Name"}
```

Issue the seller key using that client ID:

```http
POST /v1/admin/clients/SELLER_CLIENT_ID/api-keys HTTP/1.1
Host: credit.tokim.ai
Authorization: Bearer ADMIN_SESSION_TOKEN
Content-Type: application/json

{
  "name":"Production redemption key",
  "scopes":["gift-cards:redeem-anonymously"]
}
```

The response has this shape:

```json
{
  "id":"019c0000-0000-7000-8000-000000000003",
  "rawKey":"tci_live_SELLER_SECRET",
  "prefix":"tci_live_abc123"
}
```

Store `rawKey` in the seller's server-side secret store. Toking stores only its
hash and cannot display the raw key later. Create a replacement key when one is
lost or rotated, and deactivate the previous credential before using its
replacement.

## Step 1: redeem a purchased gift card

The seller's backend sends the gift-card code to the Credit API. Generate a
unique idempotency key for the redemption attempt and retain it until the request
has a definite response.

```http
POST /v1/client/gift-cards/redeem-anonymously HTTP/1.1
Host: credit.tokim.ai
Authorization: Bearer tci_live_REPLACE_WITH_SELLER_KEY
Content-Type: application/json
Idempotency-Key: 8f40d778-25c4-4603-a444-a31b215812ed

{"code":"TK7M9X2P4R8W6Y3N5"}
```

A successful response creates an anonymous Credit Account and returns its Toking
AI credential:

```json
{
  "transactionId": "019c0000-0000-7000-8000-000000000001",
  "creditAccountId": "019c0000-0000-7000-8000-000000000002",
  "credited": "10000",
  "balanceAfter": "10000",
  "baseUrl": "https://api.tokim.ai/v1",
  "modelsUrl": "https://api.tokim.ai/v1/models",
  "chatCompletionsUrl": "https://api.tokim.ai/v1/chat/completions",
  "apiKey": "tk_live_NEW_CUSTOMER_KEY",
  "apiKeyPrefix": "tk_live_abc123"
}
```

Credit values are decimal strings. The gift card is consumed atomically with
the credit ledger entry and account creation.

The `tk_live_...` key belongs to the purchaser's new Credit Account. Deliver it
to the purchaser over the authenticated purchase session and show it as a
secret. If the seller provides a hosted AI experience instead, encrypt the key
at rest and never mix it with the seller's `tci_live_...` credential.

If the seller loses the HTTP response, retry the same code with the same
`Idempotency-Key`. Toking returns the original result, including the same newly
issued customer API key. Reusing that idempotency key with another code returns
409. Retrying with a new key after a successful redemption returns a
card-unavailable error.

## Step 2: fetch and display the models

After successful redemption, call the returned `modelsUrl` with the returned
customer key:

```http
GET /v1/models HTTP/1.1
Host: api.tokim.ai
Authorization: Bearer tk_live_NEW_CUSTOMER_KEY
Accept: application/json
```

```json
{
  "object": "list",
  "data": [
    {
      "id": "gangram/vendor/model-name",
      "object": "model",
      "created": 1788393600,
      "owned_by": "vendor",
      "provider": "gangram",
      "name": "Display name",
      "description": "Optional description",
      "context_length": 131072,
      "supported_parameters": ["temperature", "tools"]
    }
  ]
}
```

Treat each model `id` as opaque and use it exactly as returned. The storefront
may cache this response briefly for the redeemed customer, but it should refresh
it because providers can add, disable, or remove models. A model-catalog failure
does not undo the successful redemption; retry this safe read separately.

The seller's `tci_live_...` key cannot list models or call inference. Both actions
require the redeemed customer's `tk_live_...` key.

## Step 3: use a selected model

Use a returned model ID and the same customer key for inference:

```http
POST /v1/chat/completions HTTP/1.1
Host: api.tokim.ai
Authorization: Bearer tk_live_NEW_CUSTOMER_KEY
Content-Type: application/json

{
  "model": "gangram/vendor/model-name",
  "messages": [{"role":"user","content":"Hello"}]
}
```

## Errors the storefront should handle

| Status | Meaning | Storefront action |
|---|---|---|
| 400 | Invalid request | Correct the code or request shape. |
| 401 | Invalid or revoked credential | Stop and use the correct credential for that step. |
| 402 | Customer has insufficient credits for inference | Offer another card or top-up flow. |
| 403 | Seller key lacks the redemption scope | Ask Toking to issue a correctly scoped key. |
| 404 | Gift card or model was not found | Show a neutral invalid-code/model message. |
| 409 | Card unavailable, expired, or idempotency conflict | Do not issue a second customer credential. |
| 429 | Rate limited | Retry with bounded backoff. |
| 5xx | Toking or an upstream provider is unavailable | Retry model reads; retry redemption only with the same idempotency key. |

Do not infer redemption success from a timeout. Retry using the original
idempotency key to obtain the original result.

## Toking onboarding checklist

1. Toking creates and approves the seller integration client.
2. Toking issues a production client key with
   `gift-cards:redeem-anonymously`.
3. The seller stores the integration key in its server-side secret store.
4. Both parties confirm production Credit API and AI Gateway addresses.
5. The seller tests one successful redemption, an idempotent retry, model
   listing with the returned customer key, an invalid code, an already-used
   code, and invalid-key behavior.
6. The seller verifies that its logs and analytics contain neither gift-card
   codes nor `tci_live_...` or `tk_live_...` keys.
7. Toking and the seller agree on key rotation and support contacts before launch.
