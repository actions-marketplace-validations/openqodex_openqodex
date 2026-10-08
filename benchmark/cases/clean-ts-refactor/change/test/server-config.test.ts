import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DEFAULT_HOST, DEFAULT_PORT, host, port } from "../src/server-config.ts";

test("port falls back to the default when PORT is unset or empty", () => {
  assert.equal(port({}), DEFAULT_PORT);
  assert.equal(port({ PORT: "" }), DEFAULT_PORT);
});

test("port reads a valid PORT", () => {
  assert.equal(port({ PORT: "8080" }), 8080);
});

test("port rejects a PORT that is not a whole number from 1 to 65535", () => {
  for (const bad of ["0", "65536", "80.5", "http"]) assert.throws(() => port({ PORT: bad }), /PORT must be/);
});

test("host falls back to the default when HOST is unset or empty", () => {
  assert.equal(host({}), DEFAULT_HOST);
  assert.equal(host({ HOST: "" }), DEFAULT_HOST);
  assert.equal(host({ HOST: "0.0.0.0" }), "0.0.0.0");
});
