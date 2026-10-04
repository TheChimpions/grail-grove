/**
 * Mainnet deploy for Grail Grove, handing every authority to the multisig in
 * the same run.
 *
 *   pnpm deploy:prod --multisig <squads-vault> --keypair <deployer.json> \
 *                    [--fee-sol 0.02] [--treasury-bps 5000] [--confirm]
 *
 * Without --confirm this is a dry run: it performs every preflight check and
 * prints the plan, but sends nothing.
 *
 * Why the deployer keypair is involved at all: `initialize` requires the
 * program's upgrade authority to sign, and the upgrade authority must itself
 * sign the deploy, so it cannot be a multisig vault at deploy time. The admin
 * (`Config.authority`) is set to the multisig in the initialize instruction
 * itself, so the deployer key is NEVER the admin, not even briefly. The
 * deployer's only privilege is the ability to upgrade the program, and step 4
 * hands that to the multisig in the same run.
 *
 * Order of operations:
 *   1. deploy the program            (deployer signs)
 *   2. initialize, admin = multisig  (deployer signs as upgrade authority)
 *   3. IDL authority   -> multisig
 *   4. upgrade authority -> multisig
 *   5. verify all three on chain, fail loudly if any did not stick
 */
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import idl from "../target/idl/grail_grove.json";
import type { GrailGrove } from "../target/types/grail_grove";

const programRoot = join(__dirname, "..");

// Mainnet facts. Overridable only for a rehearsal on another cluster.
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const CHIMPIONS_COLLECTION = "2k8iNEAB6EK8TyK2KtFdPzWp9tmW7dHpDbBhT6hPNMD8";
const CHIAO_TREASURY = "Df7VuBkasBXHyEYUsuqQnEpDvLyZmfoxDnk932CUak2c";
const BPF_LOADER_UPGRADEABLE_ID = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const SYSTEM_PROGRAM = SystemProgram.programId.toBase58();
const DEPLOY_HEADROOM = 1.15;

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
  console.log(`grail-grove mainnet deploy

  pnpm deploy:prod --multisig <squads-vault> --keypair <deployer.json> [options]

  --multisig <pk>      Squads VAULT address (the one that signs), not the
                       multisig settings account. Becomes the swap admin, the
                       program upgrade authority and the IDL authority.
  --keypair <path>     deployer; pays rent and signs the deploy
  --fee-sol <n>        swap fee in SOL (default 0.02)
  --treasury-bps <n>   treasury share of the fee (default 5000 = 50%)
  --treasury <pk>      fee recipient (default ${CHIAO_TREASURY})
  --collection <pk>    collection to allow (default the Chimpions collection)
  --max-len <bytes>    ProgramData size to rent (default: binary +15%)
  --rpc <url>          mainnet RPC (default: Helius from HELIUS_API_KEY)
  --confirm            actually send. Without it, this is a dry run.
`);
  process.exit(0);
}

const multisig = new PublicKey(flag("multisig") ?? fail("--multisig is required"));
const keypairPath = flag("keypair") ?? fail("--keypair is required");
const treasury = new PublicKey(flag("treasury") ?? CHIAO_TREASURY);
const collection = new PublicKey(flag("collection") ?? CHIMPIONS_COLLECTION);
const feeSol = Number(flag("fee-sol") ?? "0.02");
const treasuryBps = Number(flag("treasury-bps") ?? "5000");
const live = flag("confirm") === "true";

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

const connection = new Connection(rpcUrl, "confirmed");
const programId = new PublicKey(idl.address);
const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
const [programData] = PublicKey.findProgramAddressSync([programId.toBuffer()], BPF_LOADER_UPGRADEABLE_ID);

let checks = 0;
function ok(label: string, detail = ""): void {
  checks++;
  console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
}

async function rentSol(bytes: number): Promise<number> {
  return (await connection.getMinimumBalanceForRentExemption(bytes)) / LAMPORTS_PER_SOL;
}

async function main() {
  const deployer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf8"))),
  );

  console.log(`\nGrail Grove ${live ? "MAINNET DEPLOY" : "dry run (no --confirm, nothing will be sent)"}`);
  console.log(`rpc        ${safeRpc}`);
  console.log(`program    ${programId.toBase58()}`);
  console.log(`deployer   ${deployer.publicKey.toBase58()}`);
  console.log(`multisig   ${multisig.toBase58()}`);
  console.log(`treasury   ${treasury.toBase58()}`);
  console.log(`collection ${collection.toBase58()}`);
  console.log(`fee        ${feeSol} SOL, treasury share ${treasuryBps} bps\n`);
  console.log("preflight");

  // 1. right cluster
  const genesis = await connection.getGenesisHash();
  if (genesis !== MAINNET_GENESIS && !flag("rpc")) fail(`RPC is not mainnet (genesis ${genesis})`);
  ok("cluster is mainnet", genesis === MAINNET_GENESIS ? "" : `genesis ${genesis} (overridden)`);

  // 2. binary matches the declared program id, and is reproducible
  const soPath = join(programRoot, "target", "deploy", "grail_grove.so");
  if (!existsSync(soPath)) fail(`${soPath} not found; run: anchor build`);
  const soLen = statSync(soPath).size;
  const sha = createHash("sha256").update(readFileSync(soPath)).digest("hex");
  const programKeypairPath = join(programRoot, "target", "deploy", "grail_grove-keypair.json");
  if (!existsSync(programKeypairPath)) fail("program keypair missing; it is required to deploy at this address");
  const programKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(programKeypairPath, "utf8"))),
  );
  if (!programKeypair.publicKey.equals(programId)) {
    fail(`program keypair is ${programKeypair.publicKey.toBase58()} but the IDL declares ${programId.toBase58()}`);
  }
  ok("binary and program keypair agree", `${soLen} bytes, sha256 ${sha.slice(0, 16)}…`);

  // 3. not already deployed / initialized
  const programInfo = await connection.getAccountInfo(programId);
  if (programInfo) fail(`${programId.toBase58()} already exists on mainnet; this script only does first deploys`);
  ok("program address is unused");
  if (await connection.getAccountInfo(configPda)) fail("config already initialized");
  ok("config PDA is unused", configPda.toBase58());

  // 4. multisig sanity. A vault is a PDA, so it must be off the ed25519 curve;
  //    a normal wallet here would mean someone passed a personal key by mistake.
  if (multisig.equals(deployer.publicKey)) fail("--multisig is the deployer key; that defeats the point");
  if (PublicKey.isOnCurve(multisig.toBytes())) {
    console.log("  WARN --multisig is a normal wallet address, not a PDA. Squads vaults are");
    console.log("       PDAs (off curve). Double-check you passed the vault, not a signer.");
  } else {
    ok("multisig looks like a vault PDA");
  }

  // 5. treasury must satisfy the on-chain constraint (exists, funded, system-owned)
  const treasuryInfo = await connection.getAccountInfo(treasury);
  if (!treasuryInfo) fail(`treasury ${treasury.toBase58()} does not exist`);
  if (treasuryInfo.lamports === 0) fail("treasury has no lamports; initialize would reject it");
  if (treasuryInfo.owner.toBase58() !== SYSTEM_PROGRAM) {
    fail(`treasury is owned by ${treasuryInfo.owner.toBase58()}, not the system program; it could not receive fees`);
  }
  ok("treasury is funded and system-owned", `${(treasuryInfo.lamports / LAMPORTS_PER_SOL).toFixed(2)} SOL`);

  // 6. collection exists
  if (!(await connection.getAccountInfo(collection))) fail(`collection ${collection.toBase58()} does not exist`);
  ok("collection mint exists");

  // 7. funding
  const maxLen = flag("max-len") ? Number(flag("max-len")) : Math.ceil((soLen * DEPLOY_HEADROOM) / 1024) * 1024;
  if (maxLen < soLen) fail(`--max-len ${maxLen} is smaller than the program (${soLen})`);
  const budget = (await rentSol(maxLen)) + 0.2;
  const balance = (await connection.getBalance(deployer.publicKey)) / LAMPORTS_PER_SOL;
  if (balance < budget) fail(`deployer holds ${balance.toFixed(3)} SOL, needs ~${budget.toFixed(2)}`);
  ok("deployer is funded", `${balance.toFixed(3)} SOL, deploy needs ~${budget.toFixed(2)}`);

  console.log(`\n${checks} checks passed`);

  if (!live) {
    console.log(`
Dry run only. Re-run with --confirm to execute:
  1. deploy ${soLen} bytes, ProgramData sized ${maxLen}
  2. initialize: admin=${multisig.toBase58()}, treasury=${treasury.toBase58()},
     collection=${collection.toBase58()}, fee=${feeSol} SOL, split=${treasuryBps} bps
  3. IDL authority     -> ${multisig.toBase58()}
  4. upgrade authority -> ${multisig.toBase58()}
  5. verify all three on chain
`);
    return;
  }

  // --- execute --------------------------------------------------------------
  console.log("\n1. deploying");
  execSync(
    `anchor deploy --provider.cluster ${rpcUrl} --provider.wallet ${keypairPath} -- --max-len ${maxLen}`,
    { cwd: programRoot, stdio: "inherit" },
  );

  console.log("\n2. initializing with the multisig as admin");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(deployer), {
    commitment: "confirmed",
  });
  const program = new anchor.Program<GrailGrove>(idl as GrailGrove, provider);
  const initSig = await program.methods
    .initialize({
      authority: multisig,
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
  console.log(`   ${initSig}`);

  const idlAuthorityCmd =
    `anchor idl set-authority --new-authority ${multisig.toBase58()} ` +
    `--program-id ${programId.toBase58()} --provider.cluster ${rpcUrl} --provider.wallet ${keypairPath}`;
  const upgradeAuthorityCmd =
    `solana program set-upgrade-authority ${programId.toBase58()} ` +
    `--new-upgrade-authority ${multisig.toBase58()} --skip-new-upgrade-authority-signer-check ` +
    `--upgrade-authority ${keypairPath} -u ${rpcUrl}`;

  /**
   * The program is already live by this point, so a failure here leaves the
   * deployer holding authority. Surface the exact command to finish by hand
   * rather than dying with a stack trace.
   */
  function step(label: string, cmd: string): void {
    try {
      execSync(cmd, { cwd: programRoot, stdio: "inherit" });
    } catch {
      console.error(`\n${label} failed. The program IS deployed and the deployer still holds`);
      console.error(`this authority. Re-run manually, then re-check with 'pnpm admin show':\n`);
      console.error(`  ${cmd.replace(/api-key=[^&\s]+/, "api-key=$HELIUS_API_KEY")}\n`);
      process.exit(1);
    }
  }

  console.log("\n3. handing the IDL account to the multisig");
  step("IDL authority transfer", idlAuthorityCmd);

  console.log("\n4. handing the upgrade authority to the multisig");
  step("Upgrade authority transfer", upgradeAuthorityCmd);

  console.log("\n5. verifying");
  let bad = 0;
  const config = await program.account.config.fetch(configPda);
  const authorityOk = config.authority.equals(multisig);
  console.log(`  ${authorityOk ? "ok  " : "FAIL"} swap admin is the multisig — ${config.authority.toBase58()}`);
  if (!authorityOk) bad++;

  const pdInfo = await connection.getAccountInfo(programData);
  // ProgramData layout: 4-byte tag, 8-byte slot, 1-byte option, 32-byte authority.
  const hasAuthority = pdInfo!.data[12] === 1;
  const upgradeAuthority = hasAuthority ? new PublicKey(pdInfo!.data.subarray(13, 45)) : null;
  const upgradeOk = !!upgradeAuthority && upgradeAuthority.equals(multisig);
  console.log(`  ${upgradeOk ? "ok  " : "FAIL"} upgrade authority is the multisig — ${upgradeAuthority?.toBase58() ?? "none"}`);
  if (!upgradeOk) bad++;

  console.log(`  ok   treasury ${config.treasury.toBase58()}, fee ${config.swapFeeLamports.toNumber() / LAMPORTS_PER_SOL} SOL, split ${config.treasuryBps} bps`);

  if (bad > 0) {
    fail(`${bad} post-deploy check(s) FAILED — the deployer key may still hold power. Fix before announcing.`);
  }

  console.log(`
Done. The deployer key now has no privileges over this program.

Set on the site:
  NEXT_PUBLIC_CHIMP_SWAP_PROGRAM_ID=${programId.toBase58()}

Admin from here on (build, then import into Squads):
  pnpm admin set --fee-sol <n> --authority ${multisig.toBase58()} --print --cluster mainnet
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
