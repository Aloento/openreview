import { build } from "esbuild";

const banner = `import { createRequire as __createRequire } from "node:module";
import { fileURLToPath as __fileURLToPath } from "node:url";
import { dirname as __nodeDirname } from "node:path";
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __nodeDirname(__filename);
`;

await build({
  banner: { js: banner },
  bundle: true,
  entryPoints: ["server.ts"],
  format: "esm",
  legalComments: "none",
  logLevel: "info",
  outfile: "dist/server.js",
  platform: "node",
  sourcemap: true,
  target: "node20",
  tsconfig: "tsconfig.json",
});
