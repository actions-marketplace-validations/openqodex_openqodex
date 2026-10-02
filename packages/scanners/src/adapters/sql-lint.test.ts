import { describe, it, expect } from "vitest";
import { lintSqlSource } from "./sql-lint.js";

const ids = (sql: string) =>
  lintSqlSource("db/x.sql", sql).map((f) => f.ruleId).sort();

describe("sql-lint: default PUBLIC EXECUTE", () => {
  it("flags a privileged function with no REVOKE FROM PUBLIC", () => {
    const sql = `CREATE OR REPLACE FUNCTION public.admin_get_hygiene()\nRETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT 1 $$;`;
    expect(ids(sql)).toContain("function-default-public-execute");
  });

  it("suppresses when the file revokes EXECUTE from PUBLIC", () => {
    const sql = `CREATE OR REPLACE FUNCTION public.admin_get_hygiene()\nRETURNS jsonb LANGUAGE sql AS $$ SELECT 1 $$;\nREVOKE EXECUTE ON FUNCTION public.admin_get_hygiene() FROM PUBLIC;\nGRANT EXECUTE ON FUNCTION public.admin_get_hygiene() TO service_role;`;
    expect(ids(sql)).not.toContain("function-default-public-execute");
  });

  it("still flags fn B when the REVOKE only covers fn A (per-function match)", () => {
    const sql = `CREATE FUNCTION public.admin_safe() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;\nREVOKE EXECUTE ON FUNCTION public.admin_safe() FROM PUBLIC;\nCREATE FUNCTION public.admin_unsafe() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;`;
    const out = lintSqlSource("db/x.sql", sql).filter(
      (f) => f.ruleId === "function-default-public-execute",
    );
    expect(out).toHaveLength(1);
    expect(out[0].message).toContain("admin_unsafe");
  });

  it("suppresses everything under a blanket ALL FUNCTIONS revoke", () => {
    const sql = `CREATE FUNCTION public.admin_a() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;\nCREATE FUNCTION public.admin_b() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;\nREVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;`;
    expect(ids(sql)).not.toContain("function-default-public-execute");
  });

  it("does NOT suppress an overloaded function when only one signature is revoked", () => {
    // admin_do_thing is overloaded; only the (text) overload is revoked,
    // so the (integer) overload is still PUBLIC. Conservative: flag both
    // since we can't confidently map the parenthesized revoke to a CREATE.
    const sql = `CREATE FUNCTION public.admin_do_thing(p text) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;\nCREATE FUNCTION public.admin_do_thing(p integer) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;\nREVOKE EXECUTE ON FUNCTION public.admin_do_thing(text) FROM PUBLIC;`;
    const out = lintSqlSource("db/x.sql", sql).filter(
      (f) => f.ruleId === "function-default-public-execute",
    );
    expect(out.length).toBe(2);
  });

  it("does NOT credit a bare-name revoke for an overloaded function (Postgres requires the signature)", () => {
    // REVOKE ... ON FUNCTION admin_do_thing FROM PUBLIC errors as
    // "function name is not unique" when overloaded, so it can't cover
    // them: flag both, conservatively.
    const sql = `CREATE FUNCTION public.admin_do_thing(p text) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;\nCREATE FUNCTION public.admin_do_thing(p integer) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;\nREVOKE EXECUTE ON FUNCTION public.admin_do_thing FROM PUBLIC;`;
    const out = lintSqlSource("db/x.sql", sql).filter(
      (f) => f.ruleId === "function-default-public-execute",
    );
    expect(out.length).toBe(2);
  });

  it("credits a bare-name revoke for a NON-overloaded function", () => {
    const sql = `CREATE FUNCTION public.admin_solo() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;\nREVOKE EXECUTE ON FUNCTION public.admin_solo FROM PUBLIC;`;
    expect(ids(sql)).not.toContain("function-default-public-execute");
  });

  it("does not flag a non-privileged function (high precision)", () => {
    const sql = `CREATE OR REPLACE FUNCTION public.get_public_stats()\nRETURNS int LANGUAGE sql AS $$ SELECT 1 $$;`;
    expect(ids(sql)).not.toContain("function-default-public-execute");
  });
});

describe("sql-lint: SECURITY DEFINER without search_path", () => {
  it("flags SECURITY DEFINER with no pinned search_path", () => {
    const sql = `CREATE FUNCTION public.do_thing() RETURNS void\nLANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN END $$;`;
    expect(ids(sql)).toContain("security-definer-no-search-path");
  });

  it("suppresses when SET search_path is pinned", () => {
    const sql = `CREATE FUNCTION public.do_thing() RETURNS void\nLANGUAGE plpgsql SECURITY DEFINER\nSET search_path = pg_catalog, public AS $$ BEGIN END $$;`;
    expect(ids(sql)).not.toContain("security-definer-no-search-path");
  });

  it("does not flag a SECURITY INVOKER (default) function", () => {
    const sql = `CREATE FUNCTION public.do_thing() RETURNS void\nLANGUAGE plpgsql AS $$ BEGIN END $$;`;
    expect(ids(sql)).not.toContain("security-definer-no-search-path");
  });

  it("scopes per function: a definer fn without search_path next to a safe one still fires once", () => {
    const sql = `CREATE FUNCTION public.safe() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ SELECT 1 $$;\nCREATE FUNCTION public.unsafe() RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN END $$;`;
    const out = lintSqlSource("db/x.sql", sql).filter(
      (f) => f.ruleId === "security-definer-no-search-path",
    );
    expect(out).toHaveLength(1);
    expect(out[0].message).toContain("unsafe");
  });
});

describe("sql-lint: unqualified COMMENT ON FUNCTION", () => {
  it("flags an unqualified COMMENT against a schema-qualified CREATE", () => {
    const sql = `CREATE OR REPLACE FUNCTION public.admin_get_teams(integer)\nRETURNS jsonb LANGUAGE sql AS $$ SELECT 1 $$;\nCOMMENT ON FUNCTION admin_get_teams(integer) IS 'list teams';`;
    expect(ids(sql)).toContain("comment-on-function-unqualified");
  });

  it("suppresses when the COMMENT is schema-qualified", () => {
    const sql = `CREATE OR REPLACE FUNCTION public.admin_get_teams(integer)\nRETURNS jsonb LANGUAGE sql AS $$ SELECT 1 $$;\nCOMMENT ON FUNCTION public.admin_get_teams(integer) IS 'list teams';`;
    expect(ids(sql)).not.toContain("comment-on-function-unqualified");
  });
});

describe("sql-lint: clean SQL", () => {
  it("returns nothing for a plain SELECT migration", () => {
    expect(lintSqlSource("db/x.sql", `SELECT 1;\nALTER TABLE t ADD COLUMN c int;`)).toEqual([]);
  });
});
