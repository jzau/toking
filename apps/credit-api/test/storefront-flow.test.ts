import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp as buildCredit } from "../src/app.js";
import { buildApp as buildGateway } from "../../ai-gateway/src/app.js";
import { gatewayConfigSchema } from "../../ai-gateway/src/config.js";
import { sql } from "../src/db/client.js";

let credit: Awaited<ReturnType<typeof buildCredit>>;
let gateway: Awaited<ReturnType<typeof buildGateway>>;
let admin: string;
let client: string;
let codes: string[];
let accountId: string;
let customerKey: string;
let failProvider = false;
let failCatalog = false;
const attempt = randomUUID();
const upstreamCalls: string[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeAll(async () => {
  credit = await buildCredit();
  const login = await credit.inject({ method: "POST", url: "/v1/admin/login", payload: { password: "development-admin" } });
  expect(login.statusCode).toBe(200);
  admin = login.json().token;
  const create = async (url: string, payload: object) => {
    const result = await credit.inject({ method: "POST", url, headers: { authorization: `Bearer ${admin}` }, payload });
    expect(result.statusCode).toBe(201);
    return result.json();
  };
  const seller = await create("/v1/admin/clients", { name: `Storefront flow test ${attempt}` });
  client = (await create(`/v1/admin/clients/${seller.id}/api-keys`, { name: "Test only", scopes: ["gift-cards:redeem-anonymously"] })).rawKey;
  const batch = await create("/v1/admin/gift-card-batches", { name: `Storefront flow test ${attempt}` });
  codes = (await create(`/v1/admin/gift-card-batches/${batch.id}/cards`, { quantity: 2, creditAmount: "10000" })).map((c: {code: string}) => c.code);
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === "http://credit.test") {
      const response = await credit.inject({ method: (init?.method ?? "GET") as "GET" | "POST", url: url.pathname, headers: Object.fromEntries(new Headers(init?.headers)), ...(init?.body ? { payload: String(init.body) } : {}) });
      return new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } });
    }
    expect(url.origin).toBe("http://provider.test");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-provider-key");
    upstreamCalls.push(url.pathname);
    if (url.pathname === "/v1/models") return failCatalog ? json({error: {message: "Temporary catalog failure"}}, 503) : json({object: "list", data: [{id: "test/model", object: "model", owned_by: "test", created: 0}]});
    expect(url.pathname).toBe("/v1/chat/completions");
    expect(JSON.parse(String(init?.body)).model).toBe("test/model");
    return failProvider ? json({error: {message: "Temporary provider failure"}}, 503) : json({id: "test-completion", object: "chat.completion", model: "test/model", choices: [{index: 0, message: {role: "assistant", content: "Hello"}, finish_reason: "stop"}], usage: {prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, cost: 0.000007}});
  };
  gateway = await buildGateway({config: gatewayConfigSchema.parse({NODE_ENV: "test", CREDIT_SERVICE_BASE_URL: "http://credit.test", MODEL_CATALOG_TTL_MS: 0, CREDITS_PER_USD: 100}), fetchImpl, providers: [{id: "test", name: "Test", baseUrl: "http://provider.test/v1", apiKey: "test-provider-key", enabled: true, adapter: "openai-compatible"}]});
});
afterAll(async () => { await gateway?.close(); await credit?.close(); await sql.end(); });
const redeem = (code: string, key = attempt, token = client) => credit.inject({method: "POST", url: "/v1/client/gift-cards/redeem-anonymously", headers: {authorization: `Bearer ${token}`, "idempotency-key": key}, payload: {code}});
const balance = async () => (await sql`select posted_balance::text as posted, reserved_balance::text as reserved from credit_accounts where id = ${accountId}`)[0];
const models = (key = customerKey) => gateway.inject({method: "GET", url: "/v1/models", headers: {authorization: `Bearer ${key}`}});

it("redeems then lists models, completes inference and checks the actual ledger", async () => {
  const result = await redeem(` ${codes[0]!.toLowerCase()} `);
  expect(result.statusCode).toBe(200);
  expect(result.json()).toMatchObject({credited: "10000", balanceAfter: "10000", baseUrl: "http://127.0.0.1:3200/v1", modelsUrl: "http://127.0.0.1:3200/v1/models", chatCompletionsUrl: "http://127.0.0.1:3200/v1/chat/completions"});
  accountId = result.json().creditAccountId;
  customerKey = result.json().apiKey;
  expect(customerKey).toMatch(/^tk_live_/);
  const retry = await redeem(codes[0]!);
  expect(retry.statusCode).toBe(200);
  expect(retry.json()).toEqual(result.json());
  expect(await balance()).toMatchObject({posted: "10000", reserved: "0"});
  const catalog = await models();
  expect(catalog.statusCode).toBe(200);
  const model = catalog.json().data[0].id;
  expect(model).toBe("test/test/model");
  expect(await balance()).toMatchObject({posted: "10000", reserved: "0"});
  const completion = await gateway.inject({method: "POST", url: "/v1/chat/completions", headers: {authorization: `Bearer ${customerKey}`}, payload: {model, messages: [{role: "user", content: "Hello"}], max_tokens: 8}});
  expect(completion.statusCode).toBe(200);
  expect(completion.json().choices[0].message.content).toBe("Hello");
  expect(await balance()).toMatchObject({posted: "9999", reserved: "0"});
  const journals = await sql`select type, count(*)::int as count from ledger_journals where source_reference in (select id::text from reservations where credit_account_id = ${accountId}) group by type`;
  expect(journals.length).toBeGreaterThan(0);
});

it("rejects invalid cards, reused cards, conflicting retries and wrong credentials", async () => {
  expect((await redeem("TKINVALID0000000", randomUUID())).statusCode).toBe(404);
  expect((await redeem(codes[0]!, randomUUID())).statusCode).toBe(409);
  expect((await redeem(codes[1]!)).json().error.code).toBe("idempotency_conflict");
  expect((await redeem(codes[1]!, randomUUID(), "invalid")).statusCode).toBe(401);
  expect((await redeem(codes[1]!, randomUUID(), customerKey)).statusCode).toBe(401);
  expect((await models(client)).statusCode).toBe(401);
  expect((await models("tk_live_" + "z".repeat(32))).statusCode).toBe(401);
  expect(await balance()).toMatchObject({posted: "9999", reserved: "0"});
});

it("recovers catalog failures without redeeming again and releases failed inference reservations", async () => {
  failCatalog = true;
  expect((await models()).statusCode).toBeGreaterThanOrEqual(500);
  expect(await balance()).toMatchObject({posted: "9999", reserved: "0"});
  failCatalog = false;
  expect((await models()).statusCode).toBe(200);
  failProvider = true;
  const response = await gateway.inject({method: "POST", url: "/v1/chat/completions", headers: {authorization: `Bearer ${customerKey}`}, payload: {model: "test/test/model", messages: [{role: "user", content: "Hello"}]}});
  expect(response.statusCode).toBe(502);
  expect(await balance()).toMatchObject({posted: "9999", reserved: "0"});
  expect(upstreamCalls.filter(path => path === "/v1/chat/completions")).toHaveLength(2);
});
