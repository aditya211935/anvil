// Bundle the deployable runtime ONCE, at Anvil's own build.
//
// `src/serve.ts` is the thin Cloud Run server every generated bundle ships as
// `runtime/server.js` and `deploy/runtime/server.js`. This script produces the
// self-contained file — Anvil's own packages, the MCP SDK, zod, everything but
// Node's built-ins inlined — that `anvil compile` then COPIES into each bundle.
//
// This is the exact esbuild configuration `@anvil/generators` used to run on
// every compile (`deployRuntime`), moved to the one place where it is sound:
// here, `node_modules` is real and `@anvil/runtime` resolves. Inside a
// single-file distribution of the CLI it did not, which is what made
// `anvil compile` impossible from a compiled binary. Moving the bundling here
// also takes esbuild — and its native platform binary — out of the CLI's
// shipped dependency closure entirely.
//
// Two files come out:
//   dist/serve.js          the runnable server (what a bundle ships)
//   dist/serve-bundle.js   the same bytes as an importable string, plus their
//                          sha256 and the package version, so the generator
//                          needs no filesystem read to find its own artifact —
//                          a plain import that survives any packer.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const dist = join(pkgRoot, "dist");
const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));

// serve.js carries @jmespath-community/jmespath (MPL-2.0) in minified form, which
// the MPL treats as Executable Form. Section 3.2(a) then requires telling whoever
// receives the file where the source is. `legalComments` cannot do it: the package
// ships no license comments to keep. The version is read from the installed copy
// so the notice always names what was actually bundled.
const jmespath = installedPackageJson("@jmespath-community/jmespath");
// The notice links the MPL text itself; a relicensed release needs a new notice.
if (jmespath.license !== "MPL-2.0") {
  throw new Error(`build-serve: ${jmespath.name} is now ${jmespath.license}; revise its notice`);
}
const thirdPartyNotice = [
  "/*!",
  ` * Includes ${jmespath.name} ${jmespath.version}, licensed under ${jmespath.license}`,
  " * (https://mozilla.org/MPL/2.0/). Source code:",
  ` * https://github.com/jmespath-community/typescript-jmespath/releases/tag/v${jmespath.version}`,
  ` * https://registry.npmjs.org/${jmespath.name}/-/jmespath-${jmespath.version}.tgz`,
  " */",
].join("\n");

/**
 * One closing comment naming every third-party package in the bundle (from the
 * esbuild metafile) with its version, declared license and the license file it
 * ships, sorted so the output stays reproducible.
 */
function bundledLicenseNotices(metafile) {
  const roots = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input.replaceAll("\\", "/"));
    if (match) roots.set(match[1], resolve(process.cwd(), match[1]));
  }
  const packages = [...roots.values()]
    .map((dir) => {
      const json = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      const file = readdirSync(dir).find((name) => /^licen[cs]e(\.(md|txt))?$/i.test(name));
      return { json, text: file ? readFileSync(join(dir, file), "utf8").trim() : undefined };
    })
    .sort(
      (a, b) =>
        a.json.name.localeCompare(b.json.name) || a.json.version.localeCompare(b.json.version),
    );
  const lines = ["", "/*!", " * Third-party software bundled in this file:"];
  for (const { json } of packages) {
    lines.push(` *   ${json.name} ${json.version} (${json.license ?? "license not declared"})`);
  }
  for (const { json, text } of packages) {
    lines.push(" *", ` * ${json.name} ${json.version}`, " *");
    const body = text ?? `${json.license ?? "No license"}; the package ships no license file.`;
    for (const line of body.replaceAll("*/", "* /").split(/\r?\n/))
      lines.push(` * ${line}`.trimEnd());
  }
  lines.push(" */", "");
  return lines.join("\n");
}

/** The installed package.json of `name`: the nearest one above its entry that names it. */
function installedPackageJson(name) {
  let dir = dirname(createRequire(join(pkgRoot, "package.json")).resolve(name));
  for (;;) {
    const file = join(dir, "package.json");
    const json = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
    if (json?.name === name) return json;
    if (dirname(dir) === dir) throw new Error(`build-serve: cannot find ${name}'s package.json`);
    dir = dirname(dir);
  }
}

mkdirSync(dist, { recursive: true });

const result = await build({
  entryPoints: [join(pkgRoot, "src", "serve.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  treeShaking: true,
  minify: true,
  legalComments: "none",
  // A few transitive CommonJS modules use dynamic require for Node built-ins.
  // ESM has no ambient require, so provide a local createRequire seam while
  // keeping every third-party package bundled into this single file.
  banner: {
    js: `${thirdPartyNotice}\nimport{createRequire as __anvilCreateRequire}from"node:module";const require=__anvilCreateRequire(import.meta.url);`,
  },
  sourcemap: false,
  write: false,
  metafile: true,
  logLevel: "silent",
});

const code = result.outputFiles[0]?.text;
if (!code) throw new Error("build-serve: esbuild produced no output for src/serve.ts");
// The MIT, ISC and BSD packages minified in here ask for their copyright and
// permission notice to travel with every copy, and `legalComments: "none"`
// keeps none of them. List every third-party package esbuild actually put in
// the file, with its own license text, at the end of the file.
const serve = `${code}${bundledLicenseNotices(result.metafile)}`;
// The bundle must be self-contained: a bare `@anvil/*` or SDK import left in
// it would mean a bundle only runs where those packages are installed — the
// exact condition this build exists to remove.
const external = serve.match(/from\s*"(@anvil\/[^"]+|@modelcontextprotocol\/[^"]+)"/);
if (external) {
  throw new Error(`build-serve: bundle still imports ${external[1]}; it is not self-contained`);
}

const sha256 = createHash("sha256").update(serve).digest("hex");
const version = String(pkg.version);

writeFileSync(join(dist, "serve.js"), serve);
writeFileSync(
  join(dist, "serve-bundle.js"),
  [
    "// Generated by scripts/build-serve.mjs — the prebuilt runtime as an importable string.",
    `export const SERVE_BUNDLE = ${JSON.stringify(serve)};`,
    `export const SERVE_BUNDLE_SHA256 = ${JSON.stringify(sha256)};`,
    `export const SERVE_BUNDLE_VERSION = ${JSON.stringify(version)};`,
    "",
  ].join("\n"),
);
writeFileSync(
  join(dist, "serve-bundle.d.ts"),
  [
    "/** The self-contained deployable runtime (`dist/serve.js`), as text. */",
    "export declare const SERVE_BUNDLE: string;",
    "/** sha256 of SERVE_BUNDLE — the runtime's own content identity. */",
    "export declare const SERVE_BUNDLE_SHA256: string;",
    "/** The @anvil/mcp-runtime version that built it. */",
    "export declare const SERVE_BUNDLE_VERSION: string;",
    "",
  ].join("\n"),
);

console.log(
  `build-serve: dist/serve.js ${(serve.length / 1024).toFixed(0)} KB sha256 ${sha256.slice(0, 12)}…`,
);
