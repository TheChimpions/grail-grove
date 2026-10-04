// Copies the built IDL + TypeScript types into a client app so the web
// client and the on-chain program never drift. Run after `anchor build`.
//
//   pnpm sync-idl [app-dir]
//
// app-dir defaults to $GRAIL_GROVE_APP_DIR, then ../the-chimpions.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const programRoot = join(here, "..");
const appDir = resolve(
  process.argv[2] ?? process.env.GRAIL_GROVE_APP_DIR ?? join(programRoot, "..", "the-chimpions"),
);
if (!existsSync(join(appDir, "package.json"))) {
  console.error(`error: ${appDir} does not look like an app (no package.json)`);
  process.exit(1);
}
const dest = join(appDir, "src", "lib", "chimp-swap", "idl");
mkdirSync(dest, { recursive: true });

for (const [from, to] of [
  ["target/idl/grail_grove.json", "grail_grove.json"],
  ["target/types/grail_grove.ts", "grail_grove.ts"],
]) {
  copyFileSync(join(programRoot, from), join(dest, to));
  console.log(`synced ${from} → ${join(dest, to)}`);
}
