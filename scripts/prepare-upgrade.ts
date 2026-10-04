/**
 * Prepare a program upgrade for the Squads vault to execute.
 *
 * Once the upgrade authority is the vault, no hot wallet can upgrade the
 * program. The flow is:
 *
 *   1. pnpm upgrade:prepare --multisig <vault> --keypair <deployer.json> --cluster mainnet [--confirm]
 *        - checks the vault really is the program's upgrade authority
 *        - writes target/deploy/grail_grove.so to a fresh buffer account
 *        - hands the buffer's authority to the vault
 *        - prints the buffer address and the binary's sha256
 *   2. In Squads: Developers -> Programs -> Upgrade, program id + buffer
 *      address. Members review (compare the sha256 against a verifiable
 *      build of the tagged commit), approve, and execute after the time lock.
 *   3. pnpm upgrade:prepare --check <buffer> --cluster mainnet
 *        - anyone can run this: confirms the on-chain buffer is byte-for-byte
 *          the local build and that the vault owns it.
 *
 * The first mainnet deploy cannot go through a buffer owned by the vault:
 * DeployWithMaxDataLen needs the program keypair and the upgrade authority to
 * sign together, and a vault PDA cannot co-sign for a fixed program id. That
 * is what scripts/deploy-mainnet.ts handles. Every later change goes
 * through this script, so the vault (and its time lock) gates all code.
 *
 * Without --confirm nothing is sent.
 */
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import idl from "../target/idl/grail_grove.json";
import { solanaSetBufferAuthority, solanaWriteBuffer } from "./lib/solana-cli";

const programRoot = join(__dirname, "..");
const BPF_LOADER_UPGRADEABLE_ID = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
/** Buffer account layout: 4-byte tag (1 = Buffer), 1-byte option, 32-byte authority, then the ELF. */
const BUFFER_HEADER_LEN = 37;

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
  console.log(`grail-grove upgrade preparation

  prepare:  pnpm upgrade:prepare --multisig <vault> --keypair <deployer.json> --cluster mainnet [--confirm]
  check:    pnpm upgrade:prepare --check <buffer> --cluster mainnet [--multisig <vault>]

  --multisig <pk>   the Squads vault that holds the upgrade authority
  --keypair <path>  hot wallet that pays for and writes the buffer
  --cluster <c>     devnet | mainnet (Helius URL from HELIUS_API_KEY) or --rpc <url>
  --check <buffer>  verify an existing buffer against the local build instead of writing one
  --confirm         actually write the buffer and hand it over
`);
  process.exit(0);
}

function heliusKey(): string | undefined {
  if (process.env.HELIUS_API_KEY) return process.env.HELIUS_API_KEY;
  const envPath = join(programRoot, ".env");
  if (!existsSync(envPath)) return undefined;
  return readFileSync(envPath, "utf8").match(/^HELIUS_API_KEY=(.*)$/m)?.[1].replace(/^"|"$/g, "") || undefined;
}
function resolveRpc(): string {
  const explicit = flag("rpc");
  if (explicit) return explicit;
  const cluster = flag("cluster") ?? fail("pass --cluster devnet|mainnet or --rpc <url>");
  if (cluster === "localnet" || cluster === "local") return "http://127.0.0.1:8899";
  const host = cluster === "devnet" ? "devnet" : "mainnet";
  const key = heliusKey();
  if (!key) fail(`--cluster ${cluster} needs HELIUS_API_KEY in the environment or .env`);
  return `https://${host}.helius-rpc.com/?api-key=${key}`;
}

const rpcUrl = resolveRpc();
const safeRpc = rpcUrl.replace(/api-key=[^&]+/, "api-key=***");
const connection = new Connection(rpcUrl, "confirmed");
const programId = new PublicKey(idl.address);
const [programData] = PublicKey.findProgramAddressSync([programId.toBuffer()], BPF_LOADER_UPGRADEABLE_ID);
const live = flag("confirm") === "true";

function localBinary(): { soPath: string; bytes: Buffer; sha: string } {
  const soPath = join(programRoot, "target", "deploy", "grail_grove.so");
  if (!existsSync(soPath)) fail(`${soPath} not found; run: anchor build (ideally solana-verify build)`);
  const bytes = readFileSync(soPath);
  return { soPath, bytes, sha: createHash("sha256").update(bytes).digest("hex") };
}

async function readUpgradeAuthority(): Promise<PublicKey | null> {
  const info = await connection.getAccountInfo(programData);
  if (!info) fail(`${programId.toBase58()} is not deployed on ${safeRpc}`);
  return info.data[12] === 1 ? new PublicKey(info.data.subarray(13, 45)) : null;
}

// --- check ----------------------------------------------------------------

async function check(bufferKey: PublicKey): Promise<void> {
  const { bytes, sha } = localBinary();
  const info = await connection.getAccountInfo(bufferKey);
  if (!info) fail(`buffer ${bufferKey.toBase58()} does not exist`);
  if (!info.owner.equals(BPF_LOADER_UPGRADEABLE_ID)) fail("buffer is not owned by the upgradeable loader");
  if (info.data.readUInt32LE(0) !== 1) fail("account is not a Buffer (tag != 1)");
  const authority = info.data[4] === 1 ? new PublicKey(info.data.subarray(5, BUFFER_HEADER_LEN)) : null;
  const onChain = info.data.subarray(BUFFER_HEADER_LEN, BUFFER_HEADER_LEN + bytes.length);
  const trailing = info.data.subarray(BUFFER_HEADER_LEN + bytes.length);
  const sameBytes = onChain.equals(bytes) && trailing.every((b) => b === 0);
  const onChainSha = createHash("sha256").update(info.data.subarray(BUFFER_HEADER_LEN, BUFFER_HEADER_LEN + bytes.length)).digest("hex");

  console.log(`buffer      ${bufferKey.toBase58()}`);
  console.log(`authority   ${authority?.toBase58() ?? "none"}`);
  console.log(`local sha   ${sha}`);
  console.log(`buffer sha  ${onChainSha}`);
  console.log(`${sameBytes ? "ok  " : "FAIL"} buffer bytes match the local build`);

  const vault = flag("multisig") ? new PublicKey(flag("multisig")!) : await readUpgradeAuthority();
  const authorityOk = !!authority && !!vault && authority.equals(vault);
  console.log(`${authorityOk ? "ok  " : "FAIL"} buffer authority is the upgrade authority (${vault?.toBase58() ?? "none"})`);
  if (!sameBytes || !authorityOk) process.exit(1);
}

// --- prepare --------------------------------------------------------------

async function prepare(): Promise<void> {
  const vault = new PublicKey(flag("multisig") ?? fail("--multisig <vault> is required"));
  const keypairPath = flag("keypair") ?? fail("--keypair <deployer.json> is required");
  const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf8"))));
  const { soPath, bytes, sha } = localBinary();

  console.log(`\nGrail Grove upgrade preparation ${live ? "(LIVE)" : "(dry run: no --confirm, nothing will be sent)"}`);
  console.log(`rpc       ${safeRpc}`);
  console.log(`program   ${programId.toBase58()}`);
  console.log(`vault     ${vault.toBase58()}`);
  console.log(`deployer  ${deployer.publicKey.toBase58()}`);
  console.log(`binary    ${bytes.length} bytes, sha256 ${sha}\n`);

  const ua = await readUpgradeAuthority();
  if (!ua) fail("the program is immutable (no upgrade authority); it cannot be upgraded");
  if (!ua.equals(vault)) fail(`upgrade authority is ${ua.toBase58()}, not --multisig ${vault.toBase58()}`);
  console.log("  ok   vault is the program's upgrade authority");

  const pd = await connection.getAccountInfo(programData);
  const maxLen = pd!.data.length - 45; // ProgramData header is 45 bytes
  if (bytes.length > maxLen) {
    fail(`binary (${bytes.length}) exceeds ProgramData capacity (${maxLen}); the vault must run 'solana program extend' first`);
  }
  console.log(`  ok   fits in ProgramData (${bytes.length} <= ${maxLen})`);

  const bufferRent = await connection.getMinimumBalanceForRentExemption(BUFFER_HEADER_LEN + bytes.length);
  const balance = await connection.getBalance(deployer.publicKey);
  const need = bufferRent + 0.05 * LAMPORTS_PER_SOL;
  if (balance < need) fail(`deployer holds ${(balance / LAMPORTS_PER_SOL).toFixed(3)} SOL, needs ~${(need / LAMPORTS_PER_SOL).toFixed(3)}`);
  console.log(`  ok   deployer funded (buffer rent ~${(bufferRent / LAMPORTS_PER_SOL).toFixed(3)} SOL, refunded to the vault's spill account on upgrade)`);

  if (!live) {
    console.log(`
Dry run only. Re-run with --confirm to:
  1. write ${bytes.length} bytes to a new buffer (deployer pays)
  2. set the buffer authority to ${vault.toBase58()}
  3. print the buffer address for the Squads upgrade proposal
`);
    return;
  }

  console.log("\n1. writing buffer");
  const buffer = solanaWriteBuffer({ rpcUrl, keypairPath, soPath, cwd: programRoot });
  console.log(`   buffer ${buffer}`);

  console.log("\n2. handing the buffer to the vault");
  solanaSetBufferAuthority({ rpcUrl, keypairPath, buffer, newAuthority: vault.toBase58(), cwd: programRoot });

  console.log("\n3. verifying");
  await check(new PublicKey(buffer));

  console.log(`
Buffer ready. In Squads (as the vault ${vault.toBase58()}):
  Developers -> Programs -> Upgrade
    program id: ${programId.toBase58()}
    buffer:     ${buffer}
    spill:      any vault-controlled address (receives the buffer rent)

Before approving, each member should confirm the binary:
  pnpm upgrade:prepare --check ${buffer} --cluster mainnet
  sha256 must be ${sha} and must match a verifiable build of the tagged commit.

If the proposal is abandoned, the vault can reclaim the rent with
  solana program close ${buffer} --recipient <vault>   (executed from Squads)
`);
}

(flag("check") ? check(new PublicKey(flag("check")!)) : prepare()).catch((err) => {
  console.error(err);
  process.exit(1);
});
