import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

describe("admin request parsing", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => { app = await buildApp(); });
  afterAll(async () => { await app.close(); });

  it("allows a bodyless provider test request to reach authentication", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/ai-providers/gangram/test",
    });
    expect(response.statusCode).toBe(401);
  });

  it.each(["", "{"])("reports invalid JSON %j as a client error", async (payload) => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/ai-providers/gangram/test",
      headers: { "content-type": "application/json" },
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "invalid_request" } });
    expect(response.json().error.requestId).toBeTruthy();
  });
});
