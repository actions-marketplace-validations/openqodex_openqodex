import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

// The published package is one file with every dependency inlined, so a user
// installs nothing but this tarball. Bundled CommonJS code that calls require()
// for Node built-ins needs a real require in ESM output, hence the shim.
export default defineConfig({
  entry: { bin: "src/bin.ts" },
  format: ["esm"],
  target: "node22",
  platform: "node",
  noExternal: [/.*/],
  splitting: false,
  dts: false,
  clean: true,
  sourcemap: false,
  define: {
    __OPENQODEX_VERSION__: JSON.stringify(pkg.version),
  },
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __openqodexCreateRequire } from "node:module";',
      "const require = __openqodexCreateRequire(import.meta.url);",
    ].join("\n"),
  },
});
