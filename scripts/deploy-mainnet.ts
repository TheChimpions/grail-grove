/**
 * Mainnet deploy for Grail Grove.
 *
 * One key: the DEPLOYER keypair. It pays, deploys, and is the swap admin
 * (Config.authority) for good, so an emergency eject or pause never waits on
 * a multisig. The admin role can eject (which only ever returns an NFT to its
 * owner), pause, set the fee (max 1 SOL, takers sign a max), set the split
 * for new listings, change the treasury address, and hand the admin role to
 * another key. It can never move an NFT.
 *
 * This script does nothing with the Chimpions multisig. After it finishes,
 * the team moves the program upgrade authority to the multisig with a Squads
 * Safe Authority Transfer (SAT), separately. The upgrade authority is the only
 * power that could ever touch listed NFTs; the published IDL and security.txt
 * move with it automatically.
 *
 * DEPLOY STEPS
 *
 *  0. Prepare
 *     - anchor build (the tested 1.0.0 binary has sha256 05770ba1…a7d96).
 *     - security.json has real contacts (the deploy refuses REPLACE_ME).
 *     - Fund the deployer with ~3.3 SOL (program rent ~2.87 SOL, IDL and
 *       metadata ~0.1 SOL, fees).
 *     - pnpm verify:mainnet      (read-only: collection, treasury, program id)
 *
 *  1. Dry run, then deploy (deployer signs)
 *       pnpm deploy:prod --keypair <deployer.json> [--fee-sol 0.2] [--treasury-bps 5000]
 *       pnpm deploy:prod --keypair <deployer.json> [same options] --confirm
 *     In order: deploy the program; create the Anchor IDL account
 *     immediately (any signer could otherwise claim it); initialize with the
 *     deployer as admin; publish the IDL and security.txt as Program Metadata
 *     (needs the upgrade authority, which the deployer holds). Then it runs
 *     every check in step 2. Resumable: re-run the same command after any
 *     failure.
 *
 *  2. Verify (read-only, any time)
 *       pnpm deploy:prod --verify --keypair <deployer.json>
 *     The on-chain program bytes match the local build, the admin is the
 *     deployer with no pending handoff, the Anchor IDL and the Program
 *     Metadata IDL and security.txt match the local files, and the config
 *     holds the expected collection. Reports who holds the upgrade authority.
 *
 *  3. Squads: Safe Authority Transfer of the upgrade authority to the
 *     multisig, following Squads' instructions. Not done by this script.
 *     Afterwards remove the deployer from the Squad's members if it was
 *     added, and re-run step 2: the upgrade authority line shows the vault.
 *
 *  4. Set NEXT_PUBLIC_CHIMP_SWAP_PROGRAM_ID on the site.
 *
 * Later code changes go through a vault-owned buffer: scripts/prepare-upgrade.ts.
 */
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import idl from "../target/idl/grail_grove.json";
import type { GrailGrove } from "../target/types/grail_grove";
import { anchorIdlInit, programMetadataFetch, programMetadataWrite, solanaProgramDeploy, solanaProgramUpgrade } from "./lib/solana-cli";

const programRoot = join(__dirname, "..");

// Mainnet facts. Overridable only for a rehearsal on another cluster.
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const CHIMPIONS_COLLECTION = "2k8iNEAB6EK8TyK2KtFdPzWp9tmW7dHpDbBhT6hPNMD8";
const CHIAO_TREASURY = "Df7VuBkasBXHyEYUsuqQnEpDvLyZmfoxDnk932CUak2c";
const BPF_LOADER_UPGRADEABLE_ID = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const SYSTEM_PROGRAM = SystemProgram.programId.toBase58();
const DEPLOY_HEADROOM = 1.15;
/** ProgramData header: 4-byte tag, 8-byte slot, 1-byte option, 32-byte authority. */
const PROGRAM_DATA_HEADER = 45;

// --- args -----------------------------------------------------------------

const argv = process.argv.slice(2);
const flags = new Map<string, string>();
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith("--")) continue;
  const next = argv[i + 1];
  if (next !== undefined && !next.startsWith("--")) { flags.set(argv[i].slice(2), next); i++; }
  else flags.set(argv[i].slice(2), "true");
}
const flag = (k: string) => flags.get(k);

function fail(msg: string): never {
  console.error(`\nerror: ${msg}`);
  process.exit(1);
}

if (flags.has("help")) {
  console.log(`grail-grove mainnet deploy (full steps are at the top of scripts/deploy-mainnet.ts)

  deploy:  pnpm deploy:prod --keypair <deployer.json> [options] [--confirm]
  verify:  pnpm deploy:prod --verify --keypair <deployer.json>   (or --admin <pk>)

  --keypair <path>     deployer; pays, deploys, and is the swap admin
  --fee-sol <n>        swap fee in SOL (default 0.02)
  --treasury-bps <n>   treasury share of the fee (default 5000 = 50%)
  --treasury <pk>      fee recipient (default ${CHIAO_TREASURY})
  --collection <pk>    collection to allow (default the Chimpions collection)
  --max-len <bytes>    ProgramData size to rent (default: binary +15%)
  --rpc <url>          mainnet RPC for deploy/transactions (default: Helius from HELIUS_API_KEY)
  --idl-cluster <c>    keyless cluster for 'anchor idl init' (default mainnet)
  --metadata-rpc <url> RPC for the program-metadata CLI (default: same as --rpc).
                       Passed through a private config file, never argv.
  --security <path>    security.txt content (default ./security.json)
  --verify             read-only: check everything on chain, send nothing
  --upgrade            replace the deployed program with the local build when
                       they differ (e.g. moving to the solana-verify build).
                       Needs the deployer to hold the upgrade authority.
  --admin <pk>         with --verify instead of --keypair: the expected admin
  --confirm            actually send. Without it, the deploy is a dry run.

This script never touches the multisig. Move the upgrade authority with a
Squads Safe Authority Transfer after the deploy verifies.
`);
  process.exit(0);
}

const verifyOnly = flag("verify") === "true";
const allowUpgrade = flag("upgrade") === "true";
const keypairPath = flag("keypair");
if (!keypairPath && !(verifyOnly && flag("admin"))) fail("--keypair is required (or --verify --admin <pk>)");
const treasury = new PublicKey(flag("treasury") ?? CHIAO_TREASURY);
const collection = new PublicKey(flag("collection") ?? CHIMPIONS_COLLECTION);
const feeSol = Number(flag("fee-sol") ?? "0.02");
const treasuryBps = Number(flag("treasury-bps") ?? "5000");
const live = flag("confirm") === "true";
const idlCluster = flag("idl-cluster") ?? "mainnet";
const idlPath = join(programRoot, "target", "idl", "grail_grove.json");
const securityPath = flag("security") ?? join(programRoot, "security.json");
const soPath = join(programRoot, "target", "deploy", "grail_grove.so");
const programKeypairPath = join(programRoot, "target", "deploy", "grail_grove-keypair.json");

if (!Number.isFinite(feeSol) || feeSol < 0 || feeSol > 1) fail("--fee-sol must be between 0 and 1");
if (!Number.isInteger(treasuryBps) || treasuryBps < 0 || treasuryBps > 10_000) fail("--treasury-bps must be 0..10000");

function heliusKey(): string | undefined {
  if (process.env.HELIUS_API_KEY) return process.env.HELIUS_API_KEY;
  const envPath = join(programRoot, ".env");
  if (!existsSync(envPath)) return undefined;
  return readFileSync(envPath, "utf8").match(/^HELIUS_API_KEY=(.*)$/m)?.[1].replace(/^"|"$/g, "") || undefined;
}
const rpcUrl =
  flag("rpc") ??
  (heliusKey() ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey()}` : "https://api.mainnet-beta.solana.com");
const safeRpc = rpcUrl.replace(/api-key=[^&]+/, "api-key=***");
const metadataRpc = flag("metadata-rpc") ?? rpcUrl;

const connection = new Connection(rpcUrl, "confirmed");
const programId = new PublicKey(idl.address);
const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
const [programData] = PublicKey.findProgramAddressSync([programId.toBuffer()], BPF_LOADER_UPGRADEABLE_ID);

let checks = 0;
function ok(label: string, detail = ""): void {
  checks++;
  console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
}
const short = (pk: PublicKey | null | undefined) => (pk ? pk.toBase58() : "none");

// --- on-chain readers -----------------------------------------------------

/** Upgrade authority from the ProgramData account, or null if none / not deployed. */
async function readUpgradeAuthority(): Promise<PublicKey | null | "missing"> {
  const info = await connection.getAccountInfo(programData);
  if (!info) return "missing";
  return info.data[12] === 1 ? new PublicKey(info.data.subarray(13, 45)) : null;
}

/**
 * Anchor IDL account: 8-byte discriminator, authority (32), data length (u32),
 * then the zlib-compressed IDL JSON.
 */
async function readAnchorIdl(): Promise<{ address: PublicKey; authority: PublicKey; json: string } | { address: PublicKey; authority: "missing" }> {
  const [base] = PublicKey.findProgramAddressSync([], programId);
  const address = await PublicKey.createWithSeed(base, "anchor:idl", programId);
  const info = await connection.getAccountInfo(address);
  if (!info) return { address, authority: "missing" };
  const authority = new PublicKey(info.data.subarray(8, 40));
  const len = info.data.readUInt32LE(40);
  let json = "";
  try { json = inflateSync(info.data.subarray(44, 44 + len)).toString("utf8"); } catch { json = ""; }
  return { address, authority, json };
}

/**
 * A freshly deployed program cannot be invoked until the cluster has moved
 * past its deploy slot ("Program is not deployed"). Wait for that before the
 * first instruction, so the Anchor IDL account is created as early as
 * possible without wasting retries.
 */
async function waitForProgramActive(timeoutMs = 120_000): Promise<void> {
  const info = await connection.getAccountInfo(programData);
  if (!info) fail("ProgramData account not found after deploy");
  const deploySlot = Number(info.data.readBigUInt64LE(4));
  const started = Date.now();
  while ((await connection.getSlot("confirmed")) <= deploySlot + 1) {
    if (Date.now() - started > timeoutMs) fail(`cluster did not advance past deploy slot ${deploySlot}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function clusterCheck(): Promise<void> {
  const genesis = await connection.getGenesisHash();
  if (genesis !== MAINNET_GENESIS && !flag("rpc")) fail(`RPC is not mainnet (genesis ${genesis})`);
  ok("cluster is mainnet", genesis === MAINNET_GENESIS ? "" : `genesis ${genesis} (overridden)`);
}

/**
 * security.txt must be real before it goes on chain: valid JSON, the fields
 * explorers show, and no REPLACE_ME placeholders left in it.
 */
function checkSecurityFile(): void {
  if (!existsSync(securityPath)) fail(`${securityPath} not found`);
  let parsed: { name?: unknown; contacts?: unknown; policy?: unknown };
  try {
    parsed = JSON.parse(readFileSync(securityPath, "utf8"));
  } catch (err) {
    fail(`${securityPath} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed.name !== "string" || !parsed.name) fail(`${securityPath}: "name" is required`);
  if (!Array.isArray(parsed.contacts) || parsed.contacts.length === 0) fail(`${securityPath}: "contacts" must be a non-empty list`);
  if (typeof parsed.policy !== "string" || !parsed.policy) fail(`${securityPath}: "policy" is required`);
  if (readFileSync(securityPath, "utf8").includes("REPLACE_ME")) {
    fail(`${securityPath} still has REPLACE_ME placeholders; fill in the real security contacts first`);
  }
  ok("security.txt content is complete", securityPath);
}

const canonJson = (text: string) => JSON.stringify(JSON.parse(text));

/** Compare the on-chain canonical Program Metadata for `seed` with a local JSON file. */
function metadataMatches(seed: string, localPath: string): "match" | "differs" | "missing" {
  const dir = mkdtempSync(join(tmpdir(), "grail-grove-meta-"));
  try {
    const out = join(dir, `${seed}.json`);
    if (!programMetadataFetch({ rpcUrl: metadataRpc, programId: programId.toBase58(), seed, outPath: out, cwd: programRoot })) {
      return "missing";
    }
    return canonJson(readFileSync(out, "utf8")) === canonJson(readFileSync(localPath, "utf8")) ? "match" : "differs";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function loadDeployer(): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keypairPath!, "utf8"))));
}

function makeProgram(wallet: anchor.Wallet): anchor.Program<GrailGrove> {
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  return new anchor.Program<GrailGrove>(idl as GrailGrove, provider);
}

function localBinary(): { bytes: Buffer; sha: string } {
  if (!existsSync(soPath)) fail(`${soPath} not found; run: anchor build`);
  const bytes = readFileSync(soPath);
  return { bytes, sha: createHash("sha256").update(bytes).digest("hex") };
}

/** Does the deployed ProgramData hold exactly `bytes` (zero-padded)? */
async function onChainMatches(bytes: Buffer): Promise<boolean | "missing"> {
  const pd = await connection.getAccountInfo(programData);
  if (!pd) return "missing";
  const onChain = pd.data.subarray(PROGRAM_DATA_HEADER, PROGRAM_DATA_HEADER + bytes.length);
  const tail = pd.data.subarray(PROGRAM_DATA_HEADER + bytes.length);
  return onChain.equals(bytes) && tail.every((b) => b === 0);
}

// --- verify (read-only) ---------------------------------------------------

/**
 * Every launch check, read-only. Used at the end of the deploy and on its own
 * with --verify. Returns the number of failures.
 */
async function verify(admin: PublicKey, program: anchor.Program<GrailGrove>): Promise<number> {
  let bad = 0;
  const report = (good: boolean, label: string, detail = "") => {
    console.log(`  ${good ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
    if (!good) bad++;
  };

  // The deployed bytes are the local build (and so the tested one, if the
  // sha256 matches the one recorded in the audit).
  const { bytes, sha } = localBinary();
  const matches = await onChainMatches(bytes);
  if (matches === "missing") {
    report(false, "program is deployed", `${programId.toBase58()} has no ProgramData`);
    return bad;
  }
  report(matches, "on-chain program matches the local build", `sha256 ${sha}`);

  const ua = await readUpgradeAuthority();
  if (ua === "missing" || ua === null) {
    console.log(`  info upgrade authority: ${ua === null ? "none (program is immutable)" : "missing"}`);
  } else if (ua.equals(admin)) {
    console.log(`  info upgrade authority is still the deployer ${ua.toBase58()}; move it to the multisig with a Squads SAT`);
  } else {
    console.log(`  info upgrade authority is ${ua.toBase58()} (confirm this is the Chimpions multisig vault)`);
  }

  const cfg = await program.account.config.fetchNullable(configPda);
  if (!cfg) {
    report(false, "config is initialized");
  } else {
    report(cfg.authority.equals(admin), "swap admin is the deployer", cfg.authority.toBase58());
    // A leftover proposal would let that key take the admin role whenever it likes.
    report(cfg.pendingAuthority.equals(PublicKey.default), "no pending admin handoff", cfg.pendingAuthority.toBase58());
    report(cfg.collection.equals(collection), "config collection is the expected collection", cfg.collection.toBase58());
    console.log(`  info treasury ${cfg.treasury.toBase58()}, fee ${cfg.swapFeeLamports.toNumber() / LAMPORTS_PER_SOL} SOL, split ${cfg.treasuryBps} bps, paused ${cfg.paused}`);
  }

  const anchorIdl = await readAnchorIdl();
  if (anchorIdl.authority === "missing") {
    report(false, "Anchor IDL account exists", anchorIdl.address.toBase58());
  } else {
    report(anchorIdl.authority.equals(admin), "Anchor IDL authority is the deployer", anchorIdl.authority.toBase58());
    let same = false;
    try { same = canonJson(anchorIdl.json) === canonJson(readFileSync(idlPath, "utf8")); } catch { same = false; }
    report(same, "Anchor IDL matches the local IDL", anchorIdl.address.toBase58());
  }

  for (const [seed, path] of [["idl", idlPath], ["security", securityPath]] as const) {
    const state = metadataMatches(seed, path);
    report(state === "match", `Program Metadata "${seed}" ${state === "match" ? "matches" : state === "missing" ? "is missing on chain, vs" : "differs from"} ${path}`);
  }
  return bad;
}

async function verifyRun(): Promise<void> {
  const admin = keypairPath ? loadDeployer().publicKey : new PublicKey(flag("admin")!);
  const program = makeProgram({ publicKey: admin } as anchor.Wallet);
  console.log(`\nGrail Grove verify (read-only)\nrpc        ${safeRpc}\nprogram    ${programId.toBase58()}\nadmin      ${admin.toBase58()}\n`);
  await clusterCheck();
  const bad = await verify(admin, program);
  if (bad > 0) fail(`${bad} check(s) FAILED`);
  console.log("\nall checks passed");
}

// --- deploy ---------------------------------------------------------------

async function deployRun(): Promise<void> {
  const deployer = loadDeployer();
  const program = makeProgram(new anchor.Wallet(deployer));
  console.log(`\nGrail Grove deploy ${live ? "(LIVE)" : "(dry run: no --confirm, nothing will be sent)"}`);
  console.log(`rpc        ${safeRpc}`);
  console.log(`program    ${programId.toBase58()}`);
  console.log(`deployer   ${deployer.publicKey.toBase58()}  (pays, deploys, swap admin)`);
  console.log(`treasury   ${treasury.toBase58()}`);
  console.log(`collection ${collection.toBase58()}`);
  console.log(`fee        ${feeSol} SOL, treasury share ${treasuryBps} bps\n`);
  console.log("preflight");

  await clusterCheck();

  const { bytes, sha } = localBinary();
  if (!existsSync(programKeypairPath)) fail("program keypair missing; it is required to deploy at this address");
  const programKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(programKeypairPath, "utf8"))));
  if (!programKeypair.publicKey.equals(programId)) {
    fail(`program keypair is ${programKeypair.publicKey.toBase58()} but the IDL declares ${programId.toBase58()}`);
  }
  ok("binary and program keypair agree", `${bytes.length} bytes, sha256 ${sha.slice(0, 16)}…`);
  if (!existsSync(idlPath)) fail(`${idlPath} not found; run: anchor build`);
  checkSecurityFile();

  // Where are we? A previous run may have stopped part-way.
  const programInfo = await connection.getAccountInfo(programId);
  let needDeploy = true;
  let needUpgrade = false;
  if (programInfo) {
    const ua = await readUpgradeAuthority();
    if (!programInfo.executable || ua === "missing") fail(`${programId.toBase58()} exists but is not an upgradeable program`);
    if (!ua || !ua.equals(deployer.publicKey)) {
      fail(`${programId.toBase58()} is already deployed with upgrade authority ${short(ua)}. Re-running the deploy needs the deployer to hold it; use --verify to check a finished deploy.`);
    }
    needDeploy = false;
    if (await onChainMatches(bytes)) {
      ok("program already deployed by this deployer and matches the local build; will skip deploy");
    } else if (allowUpgrade) {
      const pd = await connection.getAccountInfo(programData);
      const capacity = pd!.data.length - PROGRAM_DATA_HEADER;
      if (bytes.length > capacity) fail(`local build (${bytes.length} bytes) exceeds ProgramData capacity (${capacity}); extend it first`);
      needUpgrade = true;
      ok("deployed program differs from the local build; will upgrade (--upgrade)", `${bytes.length} <= ${capacity} bytes`);
    } else {
      fail("the deployed program differs from the local build. Pass --upgrade to replace it, or rebuild the deployed version; nothing was sent.");
    }
  } else {
    ok("program address is unused");
  }

  // The Anchor IDL account is permissionless to create. If it already exists
  // under anyone but the deployer, someone squatted it: stop and look.
  const idlBefore = await readAnchorIdl();
  const needIdlInit = idlBefore.authority === "missing";
  if (idlBefore.authority !== "missing") {
    if (!idlBefore.authority.equals(deployer.publicKey)) {
      fail(`Anchor IDL account ${idlBefore.address.toBase58()} exists with authority ${idlBefore.authority.toBase58()}: someone else created it. Investigate before continuing.`);
    }
    ok("Anchor IDL account already exists under the deployer; will skip idl init");
  }

  const config = await program.account.config.fetchNullable(configPda);
  if (config) {
    if (!config.authority.equals(deployer.publicKey)) {
      fail(`config admin is ${config.authority.toBase58()}, not the deployer; this script only resumes its own deploys`);
    }
    ok("config exists with the deployer as admin; will skip initialize");
  } else {
    ok("config PDA is unused", configPda.toBase58());
  }
  const needInit = !config;

  // treasury must satisfy the on-chain constraint (system-owned, rent exempt)
  const treasuryInfo = await connection.getAccountInfo(treasury);
  if (!treasuryInfo) fail(`treasury ${treasury.toBase58()} does not exist`);
  if (treasuryInfo.owner.toBase58() !== SYSTEM_PROGRAM) {
    fail(`treasury is owned by ${treasuryInfo.owner.toBase58()}, not the system program; initialize would reject it`);
  }
  if (treasuryInfo.lamports < (await connection.getMinimumBalanceForRentExemption(0))) {
    fail("treasury is below rent exemption; initialize would reject it");
  }
  ok("treasury is a rent-exempt system account", `${(treasuryInfo.lamports / LAMPORTS_PER_SOL).toFixed(2)} SOL`);

  if (!(await connection.getAccountInfo(collection))) fail(`collection ${collection.toBase58()} does not exist`);
  ok("collection mint exists");

  const maxLen = flag("max-len") ? Number(flag("max-len")) : Math.ceil((bytes.length * DEPLOY_HEADROOM) / 1024) * 1024;
  if (maxLen < bytes.length) fail(`--max-len ${maxLen} is smaller than the program (${bytes.length})`);
  // An upgrade's buffer rent is held only for the upgrade and comes back.
  const rentFor = async (n: number) => (await connection.getMinimumBalanceForRentExemption(n)) / LAMPORTS_PER_SOL;
  const budget =
    (needDeploy ? await rentFor(maxLen + PROGRAM_DATA_HEADER) : needUpgrade ? await rentFor(bytes.length + 37) : 0) + 0.25;
  const balance = (await connection.getBalance(deployer.publicKey)) / LAMPORTS_PER_SOL;
  if (balance < budget) fail(`deployer holds ${balance.toFixed(3)} SOL, needs ~${budget.toFixed(2)}`);
  ok("deployer is funded", `${balance.toFixed(3)} SOL, this run needs ~${budget.toFixed(2)}`);

  console.log(`\n${checks} checks passed`);

  if (!live) {
    console.log(`
Dry run only. Re-run with --confirm to execute:
  ${needDeploy ? `1. deploy ${bytes.length} bytes, ProgramData sized ${maxLen}` : needUpgrade ? `1. UPGRADE the deployed program to the local build (sha256 ${sha.slice(0, 16)}…)` : "1. (deploy: already done)"}
  ${needIdlInit ? "2. create the Anchor IDL account immediately" : "2. (Anchor IDL account: already exists)"}
  ${needInit ? `3. initialize: admin=${deployer.publicKey.toBase58()}, treasury=${treasury.toBase58()},
     collection=${collection.toBase58()}, fee=${feeSol} SOL, split=${treasuryBps} bps` : "3. (initialize: already done)"}
  4. publish the IDL and security.txt as Program Metadata (skipped if already identical)
  5. verify everything on chain
`);
    return;
  }

  if (needDeploy) {
    console.log("\n1. deploying");
    solanaProgramDeploy({ rpcUrl, keypairPath: keypairPath!, soPath, programKeypairPath, maxLen, cwd: programRoot });
  }
  if (needUpgrade) {
    console.log("\n1. upgrading the deployed program to the local build");
    solanaProgramUpgrade({ rpcUrl, keypairPath: keypairPath!, soPath, programId: programId.toBase58(), cwd: programRoot });
    if ((await onChainMatches(bytes)) !== true) fail("after the upgrade the on-chain program still differs from the local build; investigate");
  }

  if (needIdlInit) {
    console.log("\n2. creating the Anchor IDL account (before anyone else can)");
    await waitForProgramActive();
    anchorIdlInit({ cluster: idlCluster, keypairPath: keypairPath!, programId: programId.toBase58(), idlPath, cwd: programRoot });
    const idlNow = await readAnchorIdl();
    if (idlNow.authority === "missing" || !idlNow.authority.equals(deployer.publicKey)) {
      fail(`Anchor IDL account authority is ${idlNow.authority === "missing" ? "missing" : idlNow.authority.toBase58()} after idl init; investigate`);
    }
  }

  if (needInit) {
    console.log("\n3. initializing with the deployer as admin");
    const sig = await program.methods
      .initialize({
        authority: deployer.publicKey,
        collection,
        swapFeeLamports: new BN(Math.round(feeSol * LAMPORTS_PER_SOL)),
        treasuryBps,
      })
      .accountsPartial({
        config: configPda,
        payer: deployer.publicKey,
        treasury,
        program: programId,
        programData,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`   ${sig}`);
  }

  // Canonical metadata needs the upgrade authority's signature: the deployer
  // holds it until the SAT. Afterwards only the multisig can change these.
  console.log("\n4. publishing Program Metadata: IDL and security.txt");
  for (const [seed, path] of [["idl", idlPath], ["security", securityPath]] as const) {
    if (metadataMatches(seed, path) === "match") {
      console.log(`   ${seed}: already identical, skipped`);
      continue;
    }
    try {
      programMetadataWrite({ rpcUrl: metadataRpc, keypairPath: keypairPath!, programId: programId.toBase58(), seed, filePath: path, cwd: programRoot });
    } catch (err) {
      // The CLI can report failure when only its confirmation step broke
      // (e.g. a dropped websocket) after the transactions landed. Trust the
      // chain: if the content is there, carry on; otherwise stop.
      if (metadataMatches(seed, path) !== "match") throw err;
      console.log(`   ${seed}: the CLI reported an error, but the on-chain content matches; continuing`);
    }
  }

  console.log("\n5. verifying");
  const bad = await verify(deployer.publicKey, program);
  if (bad > 0) fail(`${bad} check(s) FAILED. Re-run the same command to resume, then verify again.`);

  console.log(`
Deploy done and verified. The deployer is the swap admin and, until the SAT,
the upgrade authority.

Next:
  - Squads: Safe Authority Transfer of the upgrade authority to the multisig.
    Then remove the deployer from the Squad's members if it was added.
  - Re-verify:  pnpm deploy:prod --verify --keypair ${keypairPath}
  - Site:       NEXT_PUBLIC_CHIMP_SWAP_PROGRAM_ID=${programId.toBase58()}

Admin, signed by the deployer keypair:
  pnpm admin show --cluster mainnet
  pnpm admin eject <mint> --cluster mainnet --keypair ${keypairPath}
  pnpm admin eject-all --cluster mainnet --keypair ${keypairPath}
  pnpm admin set --paused true --cluster mainnet --keypair ${keypairPath}
`);
}

(verifyOnly ? verifyRun() : deployRun()).catch((err) => {
  console.error(err);
  process.exit(1);
});
