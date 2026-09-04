# Toking AI Provider Contract V1

## Purpose

Toking is the public AI gateway and credit authority. An upstream AI provider
owns model availability and inference. A provider never receives a customer's
Toking API key and never connects to the Toking Credit Service.

The first provider is Gangram. Later providers use the same contract and are
registered independently. V1 supports OpenAI-compatible chat completions;
providers with a different native API require a gateway adapter that implements
the same internal `AiProvider` interface.

This is the Toking integration contract for Gangram to implement or map to its
existing API. Gangram's live API has not yet been connected or verified.

## Registering providers in Toking

Set `AI_PROVIDERS` to a JSON array in the gateway environment. Each entry has a
unique, stable `id`, a display `name`, an `adapter`, a versioned `baseUrl`, a
provider-issued `apiKey`, and an `enabled` flag. The currently supported adapter
is `openai-compatible`.

```json
[
  {
    "id": "gangram",
    "name": "Gangram",
    "adapter": "openai-compatible",
    "baseUrl": "https://api.gangram.example/v1",
    "apiKey": "REPLACE_WITH_PROVIDER_CREDENTIAL",
    "enabled": true
  },
  {
    "id": "another-provider",
    "name": "Another Provider",
    "adapter": "openai-compatible",
    "baseUrl": "https://another-provider.example/v1",
    "apiKey": "",
    "enabled": false
  }
]
```

The addresses above are placeholders. Store the JSON on one line when using a
`.env` file. Production configuration must use real HTTPS endpoints and secret
credentials. Restart the gateway after changing the registry. Disabled entries
are excluded from discovery and routing. The registry is deployment
configuration; there is no provider self-registration API in V1.

Providers own their catalogs; Toking does not maintain a second hardcoded model
list. Adding a provider that implements this contract needs configuration only.

## Trust boundary

Toking sends each provider a provider-specific bearer credential. Providers
must authenticate that credential, restrict it to Toking, rotate it without a
service interruption, use TLS in production, and avoid logging request content
unless the applicable retention policy permits it.

Toking generates `X-Toking-Request-Id` for every inference request. Providers
should include this opaque value in logs and support records. It contains no
customer identity. `X-Toking-Provider-Contract: 1` identifies this contract
version.

Provider error bodies are not returned to clients. Toking converts them to a
stable gateway error and records only the provider ID and HTTP status in its
normal log path.

## Provider endpoints

A provider base URL points at its versioned API root, such as
`https://api.gangram.example/v1`. Toking appends the paths below.

### `GET /models`

Return the chat models that Toking can route to this provider credential.
Disabled, private, unhealthy, or unsupported models must not be included.

```json
{
  "object": "list",
  "data": [
    {
      "id": "vendor/model-name",
      "object": "model",
      "created": 1788393600,
      "owned_by": "vendor",
      "name": "Display name",
      "description": "Optional description",
      "context_length": 131072,
      "supported_parameters": ["temperature", "tools"]
    }
  ]
}
```

Required fields are `id`, `object`, `created`, and `owned_by`. Model IDs must be
unique within the provider and stable across restarts. A model ID may contain
slashes but must not begin with the provider ID. Toking prefixes it when exposed
to clients: Gangram's `vendor/model-name` becomes
`gangram/vendor/model-name`.

Unknown fields are discarded at the Toking boundary. An invalid response makes
the provider catalog unavailable. Toking caches a valid catalog for 60 seconds
by default and coalesces concurrent refreshes. If one provider is down, the
public catalog contains healthy providers plus
`toking.unavailable_providers`. If every provider is down, Toking returns 503.

### `POST /chat/completions`

Accept an OpenAI-compatible chat completion request. Toking removes the provider
prefix before forwarding `model`, so the example above arrives as
`vendor/model-name`. Both streaming and non-streaming requests must be
supported.

A non-streaming success returns HTTP 200 and an OpenAI-compatible
`chat.completion`. The response must include `id`, `object`, `choices`, and final
`usage` when available. Toking replaces the response model with the public,
provider-prefixed model ID.

```json
{
  "id": "provider-generation-id",
  "object": "chat.completion",
  "model": "vendor/model-name",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "Hello" },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 4,
    "total_tokens": 14,
    "cost": "0.000042"
  }
}
```

`usage.cost` is the agreed upstream cost in USD for this request, represented as
a decimal string or non-negative number. When it is absent, Toking falls back
to `total_tokens`, then to its own token estimate. An explicit zero cost releases
the credit reservation. Gangram and Toking must agree on cost semantics before
production billing is enabled; taxes, discounts, and Toking's retail margin do
not belong in this provider field.

For streaming, return `Content-Type: text/event-stream` and OpenAI-compatible
SSE events separated by a blank line. A final usage event must be emitted before
`data: [DONE]`. Toking holds its own final marker until credit settlement
completes. The provider must stop generation promptly when Toking closes the
connection or aborts the request.

```text
data: {"id":"provider-generation-id","object":"chat.completion.chunk","model":"vendor/model-name","choices":[{"index":0,"delta":{"content":"Hello"}}]}

data: {"id":"provider-generation-id","object":"chat.completion.chunk","model":"vendor/model-name","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14,"cost":"0.000042"}}

data: [DONE]

```

For validation failures return 400, for unknown models return 404, and for rate
limits return 429. Other provider responses are exposed by Toking as 502. A
non-2xx response or a stream error before output releases the reservation. If a
stream has produced output, Toking captures reported or estimated usage.

## Public Toking behavior

Customers authenticate to Toking with `Authorization: Bearer tk_live_...`.
`GET /v1/models` validates the customer key without creating a credit
reservation and returns the combined provider catalog:

```json
{
  "object": "list",
  "data": [{
    "id": "gangram/vendor/model-name",
    "object": "model",
    "created": 1788393600,
    "owned_by": "vendor",
    "provider": "gangram"
  }]
}
```

The catalog is system-wide in V1. A storefront fetches it with the customer
key returned by gift-card redemption.

Customers pass that exact ID to `POST /v1/chat/completions`; integration keys
cannot call inference endpoints. Toking routes only
IDs currently present in the selected provider's catalog. A request header
cannot override model routing. This prevents client input from choosing a
credential or destination outside the configured provider registry.

Toking authenticates the client and validates the route before reserving
credits. It reserves credits before inference, captures successful usage, and
releases the reservation when the provider fails before producing output.
Captured ledger metadata includes the public model, provider ID, upstream model,
provider generation ID, and provider usage.

Toking V1 does not retry inference or fail over a request to another provider.
An automatic retry could duplicate output or cost. Cross-provider fallback can
be added later with an explicit idempotency and billing protocol.
The current request ID and reservation idempotency do not provide end-to-end
inference replay guarantees. `defaultProviderId` on Credit Accounts does not
override an explicitly prefixed public model ID; bare-model routing is not
implemented in V1.

## Gangram onboarding

Before enabling Gangram in production:

1. Gangram supplies its versioned HTTPS base URL and a Toking-specific bearer
   credential through the deployment secret store.
2. Gangram's `/models` response passes the catalog contract and contains only
   routable chat models.
3. Non-streaming and streaming calls pass model routing, cancellation, final
   usage, timeout, malformed response, 4xx, 429, and 5xx tests.
4. Both teams reconcile sampled generation IDs, token counts, and USD cost.
5. Operations verify credential rotation, catalog outage behavior, request-ID
   correlation, rate limits, content retention, and incident contacts.
6. Toking enables Gangram in `AI_PROVIDERS` and verifies the public catalog
   before sending production traffic.
