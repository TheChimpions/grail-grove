/**
 * Confirm the mainnet facts the program depends on (audit finding I-02).
 *
 *   pnpm verify:mainnet [--rpc <url>] [--sample <n>] [--mints <pk,pk,...>]
 *
 * Checks, and prints ok / FAIL for each:
 *   1. the Chimpions collection mint exists, is a Metaplex collection NFT
 *      (supply 1, decimals 0, metadata + master edition present);
 *   2. a sample of collection members (via Helius DAS, or --mints) are legacy
 *      NonFungible (token_standard None or NonFungible), have a master
 *      edition, and that edition is the mint's freeze authority. This is the
 *      exact shape `list` requires;
 *   3. the treasury is a rent-exempt system-owned account;
 *   4. the program id is either undeployed or has the expected upgrade
 *      authority, and whether the config PDA exists.
 *
 * Read-only: no keypair, nothing is sent. Needs HELIUS_API_KEY (env or .env)
 * to sample the collection; without it pass --mints explicitly.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import idl from "../target/idl/grail_grove.json";

const programRoot = join(__dirname, "..");
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const CHIMPIONS_COLLECTION = new PublicKey("2k8iNEAB6EK8TyK2KtFdPzWp9tmW7dHpDbBhT6hPNMD8");
const CHIAO_TREASURY = new PublicKey("Df7VuBkasBXHyEYUsuqQnEpDvLyZmfoxDnk932CUak2c");
const TOKEN_METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const BPF_LOADER_UPGRADEABLE_ID = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");

const argv = process.argv.slice(2);
const flags = new Map<string, string>();
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith("--")) continue;
  const next = argv[i + 1];
  if (next !== undefined && !next.startsWith("--")) { flags.set(argv[i].slice(2), next); i++; }
  else flags.set(argv[i].slice(2), "true");
}
const flag = (k: string) => flags.get(k);

function heliusKey(): string | undefined {
  if (process.env.HELIUS_API_KEY) return process.env.HELIUS_API_KEY;
  const envPath = join(programRoot, ".env");
  if (!existsSync(envPath)) return undefined;
  return readFileSync(envPath, "utf8").match(/^HELIUS_API_KEY=(.*)$/m)?.[1].replace(/^"|"$/g, "") || undefined;
}
const key = heliusKey();
const rpcUrl = flag("rpc") ?? (key ? `https://mainnet.helius-rpc.com/?api-key=${key}` : "https://api.mainnet-beta.solana.com");
const safeRpc = rpcUrl.replace(/api-key=[^&]+/, "api-key=***");
const connection = new Connection(rpcUrl, "confirmed");
const sampleSize = Number(flag("sample") ?? "25");

let failures = 0;
function report(okay: boolean, label: string, detail = ""): void {
  if (!okay) failures++;
  console.log(`  ${okay ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

const metadataPda = (mint: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    TOKEN_METADATA_PROGRAM_ID,
  )[0];
const masterEditionPda = (mint: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer(), Buffer.from("edition")],
    TOKEN_METADATA_PROGRAM_ID,
  )[0];

/** SPL Mint layout: mint_authority COption(4+32), supply u64, decimals u8, is_initialized u8, freeze_authority COption(4+32). */
function parseMint(data: Buffer) {
  const supply = data.readBigUInt64LE(36);
  const decimals = data[44];
  const hasFreeze = data.readUInt32LE(46) === 1;
  const freezeAuthority = hasFreeze ? new PublicKey(data.subarray(50, 82)) : null;
  return { supply, decimals, freezeAuthority };
}

/**
 * Minimal Metadata parser: enough to read mint, token_standard and collection.
 * Layout: key u8, update_authority 32, mint 32, name (4+len), symbol (4+len),
 * uri (4+len), seller_fee u16, creators Option<Vec<Creator(34)>>,
 * primary_sale u8, is_mutable u8, edition_nonce Option<u8>,
 * token_standard Option<u8>, collection Option<{verified u8, key 32}>.
 */
function parseMetadata(data: Buffer) {
  let o = 0;
  const key = data[o]; o += 1;
  o += 32; // update authority
  const mint = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const str = () => { const len = data.readUInt32LE(o); o += 4; const s = data.subarray(o, o + len).toString("utf8").replace(/\0+$/, ""); o += len; return s; };
  const name = str(); str(); str();
  o += 2; // seller fee
  if (data[o++] === 1) { const n = data.readUInt32LE(o); o += 4 + n * 34; }
  o += 2; // primary_sale_happened, is_mutable
  if (data[o++] === 1) o += 1; // edition_nonce
  let tokenStandard: number | null = null;
  if (data[o++] === 1) { tokenStandard = data[o]; o += 1; }
  let collection: { verified: boolean; key: PublicKey } | null = null;
  if (data[o++] === 1) { collection = { verified: data[o] === 1, key: new PublicKey(data.subarray(o + 1, o + 33)) }; o += 33; }
  return { key, mint, name, tokenStandard, collection };
}
const TOKEN_STANDARD_NAMES = ["NonFungible", "FungibleAsset", "Fungible", "NonFungibleEdition", "ProgrammableNonFungible", "ProgrammableNonFungibleEdition"];

async function sampleMints(): Promise<PublicKey[]> {
  if (flag("mints")) return flag("mints")!.split(",").map((s) => new PublicKey(s.trim()));
  if (!key) {
    console.log("  WARN no HELIUS_API_KEY and no --mints: skipping the member sample");
    return [];
  }
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: "sample", method: "getAssetsByGroup",
      params: { groupKey: "collection", groupValue: CHIMPIONS_COLLECTION.toBase58(), limit: 1000, page: 1 },
    }),
  });
  const data = (await res.json()) as { error?: unknown; result?: { total: number; items: { id: string; interface: string }[] } };
  if (data.error || !data.result) throw new Error(`Helius DAS: ${JSON.stringify(data.error)}`);
  const items = data.result.items;
  console.log(`  info DAS reports ${data.result.total} members; interfaces: ${[...new Set(items.map((i) => i.interface))].join(", ")}`);
  // Spread the sample across the list rather than taking the first n.
  const step = Math.max(1, Math.floor(items.length / sampleSize));
  return items.filter((_, i) => i % step === 0).slice(0, sampleSize).map((i) => new PublicKey(i.id));
}

async function main() {
  console.log(`\nGrail Grove mainnet assumptions\nrpc ${safeRpc}\n`);
  const genesis = await connection.getGenesisHash();
  report(genesis === MAINNET_GENESIS, "cluster is mainnet", genesis);

  // 1. collection
  console.log("\ncollection");
  const colMintInfo = await connection.getAccountInfo(CHIMPIONS_COLLECTION);
  report(!!colMintInfo && colMintInfo.owner.equals(TOKEN_PROGRAM_ID), "collection mint exists and is an SPL Token mint");
  if (colMintInfo) {
    const m = parseMint(colMintInfo.data);
    report(m.supply === 1n && m.decimals === 0, "collection mint is single-supply", `supply ${m.supply}, decimals ${m.decimals}`);
  }
  const colMeta = await connection.getAccountInfo(metadataPda(CHIMPIONS_COLLECTION));
  report(!!colMeta, "collection metadata exists");
  if (colMeta) {
    const md = parseMetadata(colMeta.data);
    console.log(`  info collection name "${md.name}", token standard ${md.tokenStandard === null ? "None" : TOKEN_STANDARD_NAMES[md.tokenStandard]}`);
  }
  report(!!(await connection.getAccountInfo(masterEditionPda(CHIMPIONS_COLLECTION))), "collection master edition exists");

  // 2. members
  console.log("\nmembers (what `list` requires)");
  const mints = await sampleMints();
  let legacy = 0, verified = 0, editionFreeze = 0;
  for (const mint of mints) {
    const [mintInfo, metaInfo, editionInfo] = await Promise.all([
      connection.getAccountInfo(mint),
      connection.getAccountInfo(metadataPda(mint)),
      connection.getAccountInfo(masterEditionPda(mint)),
    ]);
    if (!mintInfo || !metaInfo) { report(false, `${mint.toBase58()} has mint + metadata`); continue; }
    const m = parseMint(mintInfo.data);
    const md = parseMetadata(metaInfo.data);
    const isLegacy = md.tokenStandard === null || md.tokenStandard === 0;
    const isVerified = !!md.collection && md.collection.verified && md.collection.key.equals(CHIMPIONS_COLLECTION);
    const freezeOk = !!editionInfo && !!m.freezeAuthority && m.freezeAuthority.equals(masterEditionPda(mint));
    if (isLegacy) legacy++; if (isVerified) verified++; if (freezeOk) editionFreeze++;
    const problems = [
      !isLegacy && `standard=${md.tokenStandard === null ? "None" : TOKEN_STANDARD_NAMES[md.tokenStandard]}`,
      !isVerified && "not verified in collection",
      !editionInfo && "no master edition",
      editionInfo && !freezeOk && `freeze authority ${m.freezeAuthority?.toBase58() ?? "none"}`,
      (m.supply !== 1n || m.decimals !== 0) && `supply ${m.supply}/${m.decimals}`,
    ].filter(Boolean);
    if (problems.length) report(false, `${md.name} (${mint.toBase58()})`, problems.join(", "));
  }
  if (mints.length) {
    report(legacy === mints.length, `all ${mints.length} sampled members are legacy NonFungible`, `${legacy}/${mints.length}`);
    report(verified === mints.length, "all sampled members are verified in the collection", `${verified}/${mints.length}`);
    report(editionFreeze === mints.length, "all sampled members have the master edition as freeze authority", `${editionFreeze}/${mints.length}`);
  }

  // 3. treasury
  console.log("\ntreasury");
  const t = await connection.getAccountInfo(CHIAO_TREASURY);
  const rentMin = await connection.getMinimumBalanceForRentExemption(0);
  report(!!t, "treasury exists", CHIAO_TREASURY.toBase58());
  if (t) {
    report(t.owner.equals(SYSTEM_PROGRAM_ID) && !t.executable, "treasury is a system-owned wallet", `owner ${t.owner.toBase58()}`);
    report(t.lamports >= rentMin, "treasury is rent exempt", `${t.lamports / 1e9} SOL`);
  }

  // 4. program
  console.log("\nprogram");
  const programId = new PublicKey(idl.address);
  const p = await connection.getAccountInfo(programId);
  if (!p) {
    console.log(`  info ${programId.toBase58()} is not deployed yet`);
  } else {
    const [programData] = PublicKey.findProgramAddressSync([programId.toBuffer()], BPF_LOADER_UPGRADEABLE_ID);
    const pd = await connection.getAccountInfo(programData);
    const ua = pd && pd.data[12] === 1 ? new PublicKey(pd.data.subarray(13, 45)) : null;
    console.log(`  info program deployed; upgrade authority ${ua?.toBase58() ?? "none (immutable)"}`);
    if (flag("multisig")) report(!!ua && ua.equals(new PublicKey(flag("multisig")!)), "upgrade authority is the vault");
    const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
    const cfg = await connection.getAccountInfo(configPda);
    if (cfg) {
      // Config layout after the 8-byte discriminator: authority, pending, treasury, collection (32 each).
      const authority = new PublicKey(cfg.data.subarray(8, 40));
      const treasury = new PublicKey(cfg.data.subarray(72, 104));
      const collection = new PublicKey(cfg.data.subarray(104, 136));
      console.log(`  info config: authority ${authority.toBase58()}, treasury ${treasury.toBase58()}, collection ${collection.toBase58()}`);
      report(collection.equals(CHIMPIONS_COLLECTION), "config collection is the Chimpions collection");
      if (flag("multisig")) report(authority.equals(new PublicKey(flag("multisig")!)), "config authority is the vault");
    } else {
      console.log("  info config not initialized");
    }
  }

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
