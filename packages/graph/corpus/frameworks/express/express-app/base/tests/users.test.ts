import request from "supertest";
import { describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { getUser } from "../src/handlers/users.js";

describe("users", () => {
  it("answers 404 for a user that does not exist", async () => {
    const res = await request(app).get("/users/42").set("authorization", "token");
    expect(res.status).toBe(404);
  });

  it("calls the handler directly", () => {
    const sent: number[] = [];
    const res = { status: (code: number) => ({ end: () => sent.push(code) }), json: () => undefined };
    getUser({ params: { id: "7" } } as never, res as never);
    expect(sent).toEqual([404]);
  });
});
