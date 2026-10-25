// Java resolution rules the corpus cannot isolate, each on a small real
// repository built in a temp folder and parsed by the real extractor:
// 1. The tie rule: a main source binds a test copy of a class, or one
//    qualified name declared in two other projects binds certain.
// 2. The arity rule: a varargs member is not counted as fitting, a call
//    whose argument list did not parse narrows to one member, or a call
//    dispatches to an implementation of another overload.
// 3. A static star import does not bind a bare call.
// 4. new T() on a class without a declared constructor leaves a miss.
// 5. Type::instanceMethod is not a use of the method.
// 6. The ext rule: a package of a declared dependency group (pom.xml or
//    Gradle) is a gap, or a package nothing declares is called external.
// 7. An override edge joins members with different parameter counts, or a
//    static method.
// 8. The model loses the Java projects and dependency groups through a
//    saved index, or a build file is not a manifest of the change.
import { afterAll, describe, expect, it } from "vitest";
import { buildGraph, deserializeModel, isManifest, isTestPath, serializeModel } from "../src/index.js";
import type { Graph } from "../src/index.js";
import { gradleGroups, pomGroups } from "../src/discovery/projects.js";
import { at, callSites, makeRepo, symbol } from "./helpers.js";
import { removeTempDirs } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

async function graphOf(files: Record<string, string>): Promise<Graph> {
  return buildGraph({ repoRoot: makeRepo(files), store: null });
}

const lines = (...l: string[]) => `${l.join("\n")}\n`;

// The tier of every calls site into `id`, as "path:line tier".
function tiers(graph: Graph, id: string, kind = "calls"): string[] {
  return (graph.in.get(id) ?? [])
    .filter((e) => e.kind === kind)
    .flatMap((e) => e.sites.map((s) => `${s.file}:${s.line} ${s.tier}`))
    .sort();
}

const unknownsAt = (graph: Graph, site: string) => graph.unknowns.filter((u) => `${u.file}:${u.line}` === site);

describe("java tie rule", () => {
  const util = (n: number) => lines("package a.b;", "", "public class Util {", "    public static int v() {", `        return ${n};`, "    }", "}");
  const caller = (cls: string) => lines("package app;", "", "import a.b.Util;", "", `public class ${cls} {`, "    int go() {", "        return Util.v(); // CALL", "    }", "}");

  it("never binds a main source to a test copy of the class it imports", async () => {
    const files = {
      "pom.xml": "<project/>\n",
      "src/test/java/a/b/Util.java": util(2),
      "src/main/java/app/Main.java": caller("Main"),
    };
    const g = await graphOf(files);
    expect(tiers(g, symbol(g, "src/test/java/a/b/Util.java", "v", "Util"))).toEqual([]);
  });

  it("binds a test source to the test copy of its own project before the main copy", async () => {
    const files = {
      "pom.xml": "<project/>\n",
      "src/main/java/a/b/Util.java": util(1),
      "src/test/java/a/b/Util.java": util(2),
      "src/test/java/app/MainTest.java": caller("MainTest"),
    };
    const g = await graphOf(files);
    const site = at(files, "src/test/java/app/MainTest.java", "CALL");
    expect(tiers(g, symbol(g, "src/test/java/a/b/Util.java", "v", "Util"))).toEqual([`${site} certain`]);
    expect(tiers(g, symbol(g, "src/main/java/a/b/Util.java", "v", "Util"))).toEqual([]);
  });

  it("leaves a class declared in two other projects as an ambiguous gap, never a certain edge", async () => {
    const files = {
      "one/pom.xml": "<project/>\n",
      "two/pom.xml": "<project/>\n",
      "one/src/main/java/a/b/Util.java": util(1),
      "two/src/main/java/a/b/Util.java": util(2),
      "app/src/main/java/app/Main.java": caller("Main"),
      "app/pom.xml": "<project/>\n",
    };
    const g = await graphOf(files);
    const site = at(files, "app/src/main/java/app/Main.java", "CALL");
    expect(tiers(g, symbol(g, "one/src/main/java/a/b/Util.java", "v", "Util"))).toEqual([]);
    expect(tiers(g, symbol(g, "two/src/main/java/a/b/Util.java", "v", "Util"))).toEqual([]);
    expect(unknownsAt(g, site).map((u) => u.cause)).toEqual(["ambiguous"]);
  });
});

describe("java arity rule", () => {
  const fmt = lines(
    "package f;",
    "",
    "public class Fmt {",
    "    public static String fmt(String s) {",
    "        return s;",
    "    }",
    "",
    "    public static String fmt(String s, Object... rest) {",
    "        return s + rest.length;",
    "    }",
    "}",
  );

  it("counts a varargs member as fitting from its fixed parameters up", async () => {
    const files = {
      "f/Fmt.java": fmt,
      "f/Use.java": lines("package f;", "", "public class Use {", "    void go() {", '        Fmt.fmt("a"); // ONE', '        Fmt.fmt("a", 1, 2); // THREE', "    }", "}"),
    };
    const g = await graphOf(files);
    const plain = g.defsByFile.get("f/Fmt.java")?.find((n) => n.name === "fmt" && n.startLine === 4)?.id as string;
    const varargs = g.defsByFile.get("f/Fmt.java")?.find((n) => n.name === "fmt" && n.startLine === 8)?.id as string;
    expect(tiers(g, plain)).toEqual([`${at(files, "f/Use.java", "ONE")} possible`]);
    expect(tiers(g, varargs)).toEqual([`${at(files, "f/Use.java", "ONE")} possible`, `${at(files, "f/Use.java", "THREE")} certain`].sort());
  });

  it("keeps every member as possible when the argument list did not parse", async () => {
    const files = {
      "f/Fmt.java": fmt,
      "f/Use.java": lines("package f;", "", "public class Use {", "    void go() {", '        Fmt.fmt("a", +); // BROKEN', "    }", "}"),
    };
    const g = await graphOf(files);
    const site = at(files, "f/Use.java", "BROKEN");
    const fmts = (g.defsByFile.get("f/Fmt.java") ?? []).filter((n) => n.name === "fmt");
    expect(fmts.length).toBe(2);
    expect(fmts.some((n) => tiers(g, n.id).some((t) => t.startsWith(site)))).toBe(true);
    for (const n of fmts) expect(tiers(g, n.id).filter((t) => t.startsWith(site)).every((t) => t.endsWith("possible"))).toBe(true);
  });

  it("dispatches a call only to implementations whose parameter count fits", async () => {
    const files = {
      "r/Runner.java": lines("package r;", "", "public interface Runner {", "    void run();", "", "    void run(int n);", "}"),
      "r/Impl.java": lines("package r;", "", "public class Impl implements Runner {", "    public void run() {", "    }", "", "    public void run(int n) {", "    }", "}"),
      "r/Use.java": lines("package r;", "", "public class Use {", "    void go(Runner x) {", "        x.run(1); // ONE", "    }", "}"),
    };
    const g = await graphOf(files);
    const site = at(files, "r/Use.java", "ONE");
    const noArgs = g.defsByFile.get("r/Impl.java")?.find((n) => n.name === "run" && n.startLine === 4)?.id as string;
    const oneArg = g.defsByFile.get("r/Impl.java")?.find((n) => n.name === "run" && n.startLine === 7)?.id as string;
    expect(tiers(g, oneArg, "dispatches_to")).toEqual([`${site} possible`]);
    expect(tiers(g, noArgs, "dispatches_to")).toEqual([]);
  });

  it("joins an override only to the base member with the same parameter count, and never a static method", async () => {
    const files = {
      "r/Base.java": lines("package r;", "", "public class Base {", "    public void run() {", "    }", "", "    public void run(int n) {", "    }", "", "    public static void make() {", "    }", "}"),
      "r/Sub.java": lines("package r;", "", "public class Sub extends Base {", "    public void run(int n) {", "    }", "", "    public static void make() {", "    }", "}"),
    };
    const g = await graphOf(files);
    const overrides = (from: string) => (g.refsOut.get(from) ?? []).filter((e) => e.kind === "overrides").map((e) => g.nodes.get(e.to)?.startLine);
    expect(overrides(symbol(g, "r/Sub.java", "run", "Sub"))).toEqual([7]);
    expect(overrides(symbol(g, "r/Sub.java", "make", "Sub"))).toEqual([]);
  });
});

describe("java imports and values", () => {
  it("binds a bare call through a static star import", async () => {
    const files = {
      "a/b/Util.java": lines("package a.b;", "", "public class Util {", "    public static int helper() {", "        return 1;", "    }", "}"),
      "c/App.java": lines("package c;", "", "import static a.b.Util.*;", "", "public class App {", "    int go() {", "        return helper(); // CALL", "    }", "}"),
    };
    const g = await graphOf(files);
    expect(tiers(g, symbol(g, "a/b/Util.java", "helper", "Util"))).toEqual([`${at(files, "c/App.java", "CALL")} certain`]);
  });

  it("records new T() of a class without a declared constructor as a type use, with no miss and no unknown", async () => {
    const files = {
      "p/Plain.java": lines("package p;", "", "public class Plain {", "}"),
      "p/Make.java": lines("package p;", "", "public class Make {", "    Object go() {", "        return new Plain(); // NEW", "    }", "}"),
    };
    const g = await graphOf(files);
    const site = at(files, "p/Make.java", "NEW");
    const plain = symbol(g, "p/Plain.java", "Plain");
    expect((g.refsIn.get(plain) ?? []).filter((e) => e.kind === "uses_type").flatMap((e) => e.sites.map((s) => `${s.file}:${s.line}`))).toEqual([site]);
    expect(callSites(g, plain)).toEqual([]);
    expect(unknownsAt(g, site)).toEqual([]);
    expect(g.misses.filter((m) => `${m.site.file}:${m.site.line}` === site)).toEqual([]);
  });

  it("records Type::instanceMethod as a use of the instance method", async () => {
    const files = {
      "w/Worker.java": lines("package w;", "", "public class Worker {", "    public String name() {", '        return "w";', "    }", "}"),
      "w/Use.java": lines("package w;", "", "import java.util.function.Function;", "", "public class Use {", "    Function<Worker, String> pick() {", "        return Worker::name; // REF", "    }", "}"),
    };
    const g = await graphOf(files);
    const name = symbol(g, "w/Worker.java", "name", "Worker");
    expect((g.refsIn.get(name) ?? []).filter((e) => e.kind === "uses_value").flatMap((e) => e.sites.map((s) => `${s.file}:${s.line}`))).toEqual([at(files, "w/Use.java", "REF")]);
  });

  it("calls a package of a declared dependency group external and discloses a package nothing declares as a miss", async () => {
    const files = {
      "pom.xml": lines("<project>", "  <dependencies>", "    <dependency>", "      <groupId>com.google.guava</groupId>", "      <artifactId>guava</artifactId>", "    </dependency>", "  </dependencies>", "</project>"),
      "lib/build.gradle": lines("dependencies {", '    implementation("org.apache.commons:commons-lang3:3.14.0")', "}"),
      "src/App.java": lines(
        "package app;",
        "",
        "import com.google.guava.Strings;",
        "import org.apache.commons.lang3.StringUtils;",
        "import net.other.Thing;",
        "",
        "public class App {",
        "    void go() {",
        '        Strings.isNullOrEmpty("a"); // MAVEN',
        '        StringUtils.trim("a"); // GRADLE',
        "        Thing.make(); // MISS",
        "    }",
        "}",
      ),
    };
    const g = await graphOf(files);
    expect(unknownsAt(g, at(files, "src/App.java", "MAVEN"))).toEqual([]);
    expect(unknownsAt(g, at(files, "src/App.java", "GRADLE"))).toEqual([]);
    expect(g.status.externalSites).toBeGreaterThanOrEqual(2);
    const miss = unknownsAt(g, at(files, "src/App.java", "MISS"));
    expect(miss.map((u) => [u.cause, u.note])).toEqual([["miss", "the package net.other is not in the repository and no build file declares a dependency for it"]]);
    expect(g.status.status).toBe("ok");
  });
});

describe("java project model", () => {
  it("reads dependency groups from pom.xml dependencies and Gradle coordinates, and skips a property group", () => {
    expect(pomGroups("<project><groupId>me</groupId><dependencies><dependency><groupId>org.slf4j</groupId></dependency><dependency><groupId>${g}</groupId></dependency></dependencies></project>")).toEqual(["org.slf4j"]);
    expect(gradleGroups("implementation 'com.squareup.okhttp3:okhttp:4.12.0'\napi(\"io.netty:netty-all\")\nprintln \"a: b\"\n")).toEqual(["com.squareup.okhttp3", "io.netty"]);
  });

  it("never takes a groupId for a pom.xml dependency that has none from the next dependency", () => {
    expect(pomGroups("<dependencies><dependency><artifactId>x</artifactId></dependency><dependency><groupId>org.next</groupId></dependency></dependencies>")).toEqual(["org.next"]);
  });

  it("reads a long single-line Gradle file of many quotes to its end", () => {
    const line = `${'"a" '.repeat(100_000)}implementation 'org.end:lib:1.0' ${"'".repeat(1)}`;
    expect(gradleGroups(line)).toEqual(["org.end"]);
  });

  it("keeps the Java projects and dependency groups through a saved index, and reads an older one without them", async () => {
    const g = await graphOf({ "svc/pom.xml": "<project><dependencies><dependency><groupId>org.slf4j</groupId></dependency></dependencies></project>\n", "svc/A.java": "package a;\nclass A {}\n" });
    expect(g.model.javaProjects).toEqual(["svc"]);
    const kept = deserializeModel(JSON.parse(JSON.stringify(serializeModel(g.model))) as Record<string, unknown>);
    expect(kept.javaProjects).toEqual(["svc"]);
    expect([...kept.javaDeps]).toEqual(["org.slf4j"]);
    const old = serializeModel(g.model) as Record<string, unknown>;
    delete old.javaProjects;
    delete old.javaDeps;
    const restored = deserializeModel(old);
    expect(restored.javaProjects).toEqual([]);
    expect([...restored.javaDeps]).toEqual([]);
  });

  it("counts Maven and Gradle files as manifests of a change and a JUnit class file as a test", () => {
    for (const f of ["pom.xml", "a/build.gradle", "a/build.gradle.kts", "settings.gradle", "settings.gradle.kts"]) expect(isManifest(f)).toBe(true);
    expect(isTestPath("src/main/java/a/FooTest.java")).toBe(true);
    expect(isTestPath("src/main/java/a/FooIT.java")).toBe(true);
    expect(isTestPath("src/main/java/a/Foo.java")).toBe(false);
  });
});
