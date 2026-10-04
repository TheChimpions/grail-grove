/**
 * Mainnet deploy for Grail Grove, in two runs, so nothing irreversible
 * happens until the Squads vault has proven it can sign.
 *
 *   Run 1   pnpm deploy:prod --multisig <vault> --squads <multisig-settings> \
 *                            --keypair <deployer.json> [options] [--confirm]
 *
 *           preflight → deploy → initialize (admin = deployer)
 *           → propose_authority(vault). Prints the Squads transaction to import.
 *
 *   (you)   In Squads, import and execute the printed `accept_authority`
 *           transaction. Config.authority is now the vault.
 *
 *   Run 2   pnpm deploy:prod --finalize --multisig <vault> --keypair <deployer.json> [--confirm]
 *
 *           verifies on chain that the vault accepted, then hands the IDL
 *           authority and the program upgrade authority to it, and re-verifies.
 *
 * Without --confirm each run is a dry run: every check runs, nothing is sent.
 *
 * Why two runs: the upgrade authority can only be handed to a PDA with
 * --skip-new-upgrade-authority-signer-check, so a wrong address there is
 * unrecoverable, and Config.authority can only be changed by itself. Having
 * the vault execute `accept_authority` first is the proof that the address
 * is a vault your signers control. The deployer is the swap admin for the
 * minutes in between; that role can pause, re-price or eject (eject only
 * ever returns an NFT to its owner) and can never move an NFT.
 */
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import idl from "../target/idl/grail_grove.json";
import type { GrailGrove } from "../target/types/grail_grove";
import { anchorIdlSetAuthority, solanaProgramDeploy, solanaSetUpgradeAuthority } from "./lib/solana-cli";

const programRoot = join(__dirname, "..");

// Mainnet facts. Overridable only for a rehearsal on another cluster.
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const CHIMPIONS_COLLECTION = "2k8iNEAB6EK8TyK2KtFdPzWp9tmW7dHpDbBhT6hPNMD8";
const CHIAO_TREASURY = "Df7VuBkasBXHyEYUsuqQnEpDvLyZmfoxDnk932CUak2c";
const BPF_LOADER_UPGRADEABLE_ID = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const SQUADS_V4_PROGRAM_ID = new PublicKey("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");
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
  console.log(`grail-grove mainnet deploy (two runs)

  run 1:  pnpm deploy:prod --multisig <vault> --squads <settings> --keypair <deployer.json> [options]
  run 2:  pnpm deploy:prod --finalize --multisig <vault> --keypair <deployer.json> [options]

  --multisig <pk>      Squads VAULT address (the PDA that signs). Becomes the
                       swap admin, the IDL authority and the upgrade authority.
  --squads <pk>        The Squads multisig SETTINGS account the vault belongs
                       to. The vault PDA is derived from it and must equal
                       --multisig. Required unless --skip-squads-check.
  --vault-index <n>    Squads vault index (default 0).
  --keypair <path>     deployer; pays rent, signs the deploy, interim admin
  --fee-sol <n>        swap fee in SOL (default 0.02)
  --treasury-bps <n>   treasury share of the fee (default 5000 = 50%)
  --treasury <pk>      fee recipient (default ${CHIAO_TREASURY})
  --collection <pk>    collection to allow (default the Chimpions collection)
  --max-len <bytes>    ProgramData size to rent (default: binary +15%)
  --rpc <url>          mainnet RPC for deploy/transactions (default: Helius from HELIUS_API_KEY)
  --idl-cluster <c>    keyless cluster for 'anchor idl set-authority' (default mainnet)
  --finalize           run 2: hand IDL + upgrade authority to the vault
  --confirm            actually send. Without it, this is a dry run.
  --skip-squads-check  allow a --multisig that is not a derivable Squads v4 vault
`);
  process.exit(0);
}

const vault = new PublicKey(flag("multisig") ?? fail("--multisig <vault> is required"));
const keypairPath = flag("keypair") ?? fail("--keypair is required");
const treasury = new PublicKey(flag("treasury") ?? CHIAO_TREASURY);
const collection = new PublicKey(flag("collection") ?? CHIMPIONS_COLLECTION);
const feeSol = Number(flag("fee-sol") ?? "0.02");
const treasuryBps = Number(flag("treasury-bps") ?? "5000");
const live = flag("confirm") === "true";
const finalize = flag("finalize") === "true";
const idlCluster = flag("idl-cluster") ?? "mainnet";

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

async function rentSol(bytes: number): Promise<number> {
  return (await connection.getMinimumBalanceForRentExemption(bytes)) / LAMPORTS_PER_SOL;
}

// --- on-chain readers -----------------------------------------------------

/** Upgrade authority from the ProgramData account, or null if none / not deployed. */
async function readUpgradeAuthority(): Promise<PublicKey | null | "missing"> {
  const info = await connection.getAccountInfo(programData);
  if (!info) return "missing";
  // ProgramData layout: 4-byte tag, 8-byte slot, 1-byte option, 32-byte authority.
  return info.data[12] === 1 ? new PublicKey(info.data.subarray(13, 45)) : null;
}

/** Anchor IDL account address and its stored authority (bytes 8..40). */
async function readIdlAuthority(): Promise<{ address: PublicKey; authority: PublicKey | "missing" }> {
  const [base] = PublicKey.findProgramAddressSync([], programId);
  const address = await PublicKey.createWithSeed(base, "anchor:idl", programId);
  const info = await connection.getAccountInfo(address);
  if (!info) return { address, authority: "missing" };
  return { address, authority: new PublicKey(info.data.subarray(8, 40)) };
}

async function readConfig(program: anchor.Program<GrailGrove>) {
  return program.account.config.fetchNullable(configPda);
}

// --- shared preflight -----------------------------------------------------

async function clusterCheck(): Promise<void> {
  const genesis = await connection.getGenesisHash();
  if (genesis !== MAINNET_GENESIS && !flag("rpc")) fail(`RPC is not mainnet (genesis ${genesis})`);
  ok("cluster is mainnet", genesis === MAINNET_GENESIS ? "" : `genesis ${genesis} (overridden)`);
}

/**
 * The vault must be a PDA derived from a real Squads v4 multisig account.
 * This is what catches a settings address pasted instead of the vault, a
 * vault from the wrong multisig, or a typo.
 */
async function squadsCheck(deployer: PublicKey): Promise<void> {
  if (vault.equals(deployer)) fail("--multisig is the deployer key; that defeats the point");
  if (PublicKey.isOnCurve(vault.toBytes())) {
    fail("--multisig is a normal wallet address, not a PDA. Squads vaults are PDAs; pass the vault, not a signer.");
  }
  if (flag("skip-squads-check") === "true") {
    console.log("  WARN --skip-squads-check: not verifying that --multisig is a Squads vault");
    return;
  }
  const settings = new PublicKey(flag("squads") ?? fail("--squads <multisig-settings> is required (or --skip-squads-check)"));
  const index = Number(flag("vault-index") ?? "0");
  if (!Number.isInteger(index) || index < 0 || index > 255) fail("--vault-index must be 0..255");
  const settingsInfo = await connection.getAccountInfo(settings);
  if (!settingsInfo) fail(`Squads settings account ${settings.toBase58()} does not exist`);
  if (!settingsInfo.owner.equals(SQUADS_V4_PROGRAM_ID)) {
    fail(`${settings.toBase58()} is owned by ${settingsInfo.owner.toBase58()}, not the Squads v4 program`);
  }
  const [derived] = PublicKey.findProgramAddressSync(
    [Buffer.from("multisig"), settings.toBuffer(), Buffer.from("vault"), Buffer.from([index])],
    SQUADS_V4_PROGRAM_ID,
  );
  if (!derived.equals(vault)) {
    fail(`vault ${index} of multisig ${settings.toBase58()} is ${derived.toBase58()}, not --multisig ${vault.toBase58()}`);
  }
  ok("multisig is a Squads v4 vault", `vault ${index} of ${settings.toBase58()}`);
}

function loadDeployer(): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf8"))));
}

function makeProgram(deployer: Keypair): anchor.Program<GrailGrove> {
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(deployer), { commitment: "confirmed" });
  return new anchor.Program<GrailGrove>(idl as GrailGrove, provider);
}

function printHeader(deployer: Keypair, title: string): void {
  console.log(`\nGrail Grove ${title} ${live ? "(LIVE)" : "(dry run: no --confirm, nothing will be sent)"}`);
  console.log(`rpc        ${safeRpc}`);
  console.log(`program    ${programId.toBase58()}`);
  console.log(`deployer   ${deployer.publicKey.toBase58()}`);
  console.log(`vault      ${vault.toBase58()}`);
}

// --- run 1: deploy, initialize, propose ------------------------------------

async function bootstrap(): Promise<void> {
  const deployer = loadDeployer();
  const program = makeProgram(deployer);
  printHeader(deployer, "run 1: deploy + initialize + propose");
  console.log(`treasury   ${treasury.toBase58()}`);
  console.log(`collection ${collection.toBase58()}`);
  console.log(`fee        ${feeSol} SOL, treasury share ${treasuryBps} bps\n`);
  console.log("preflight");

  await clusterCheck();

  // binary matches the declared program id
  const soPath = join(programRoot, "target", "deploy", "grail_grove.so");
  if (!existsSync(soPath)) fail(`${soPath} not found; run: anchor build`);
  const soLen = statSync(soPath).size;
  const sha = createHash("sha256").update(readFileSync(soPath)).digest("hex");
  const programKeypairPath = join(programRoot, "target", "deploy", "grail_grove-keypair.json");
  if (!existsSync(programKeypairPath)) fail("program keypair missing; it is required to deploy at this address");
  const programKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(programKeypairPath, "utf8"))));
  if (!programKeypair.publicKey.equals(programId)) {
    fail(`program keypair is ${programKeypair.publicKey.toBase58()} but the IDL declares ${programId.toBase58()}`);
  }
  ok("binary and program keypair agree", `${soLen} bytes, sha256 ${sha.slice(0, 16)}…`);

  // where are we? (a previous run may have stopped part-way)
  const programInfo = await connection.getAccountInfo(programId);
  let needDeploy = true;
  if (programInfo) {
    const ua = await readUpgradeAuthority();
    if (!programInfo.executable || ua === "missing") fail(`${programId.toBase58()} exists but is not an upgradeable program`);
    if (!ua || !ua.equals(deployer.publicKey)) {
      fail(`${programId.toBase58()} is already deployed with upgrade authority ${short(ua)}; this script only resumes its own deploys`);
    }
    needDeploy = false;
    ok("program already deployed by this deployer; will skip deploy");
  } else {
    ok("program address is unused");
  }

  const config = await readConfig(program);
  let needInit = true;
  let needPropose = true;
  if (config) {
    needInit = false;
    if (config.authority.equals(vault)) {
      needPropose = false;
      ok("config exists and the vault is already its authority (run 1 is complete; use --finalize)");
    } else if (config.authority.equals(deployer.publicKey)) {
      needPropose = !config.pendingAuthority.equals(vault);
      ok("config exists with the deployer as interim authority", needPropose ? "will propose the vault" : "vault already proposed");
    } else {
      fail(`config authority is ${config.authority.toBase58()}, neither the deployer nor the vault`);
    }
  } else {
    ok("config PDA is unused", configPda.toBase58());
  }

  await squadsCheck(deployer.publicKey);

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

  // funding
  const maxLen = flag("max-len") ? Number(flag("max-len")) : Math.ceil((soLen * DEPLOY_HEADROOM) / 1024) * 1024;
  if (maxLen < soLen) fail(`--max-len ${maxLen} is smaller than the program (${soLen})`);
  const budget = (needDeploy ? await rentSol(maxLen) : 0) + 0.2;
  const balance = (await connection.getBalance(deployer.publicKey)) / LAMPORTS_PER_SOL;
  if (balance < budget) fail(`deployer holds ${balance.toFixed(3)} SOL, needs ~${budget.toFixed(2)}`);
  ok("deployer is funded", `${balance.toFixed(3)} SOL, this run needs ~${budget.toFixed(2)}`);

  console.log(`\n${checks} checks passed`);

  const acceptCmd = `pnpm admin accept-authority --authority ${vault.toBase58()} --print --cluster mainnet`;
  const finalizeCmd = `pnpm deploy:prod --finalize --multisig ${vault.toBase58()} --keypair ${keypairPath} --confirm`;

  if (!live) {
    console.log(`
Dry run only. Re-run with --confirm to execute:
  ${needDeploy ? `1. deploy ${soLen} bytes, ProgramData sized ${maxLen}` : "1. (deploy: already done)"}
  ${needInit ? `2. initialize: admin=${deployer.publicKey.toBase58()} (interim), treasury=${treasury.toBase58()},
     collection=${collection.toBase58()}, fee=${feeSol} SOL, split=${treasuryBps} bps` : "2. (initialize: already done)"}
  ${needPropose ? `3. propose_authority -> ${vault.toBase58()}` : "3. (propose: already done)"}
Then have the vault execute accept_authority (build it with: ${acceptCmd})
and finish with: ${finalizeCmd}
`);
    return;
  }

  if (needDeploy) {
    console.log("\n1. deploying");
    solanaProgramDeploy({ rpcUrl, keypairPath, soPath, programKeypairPath, maxLen, cwd: programRoot });
  }

  if (needInit) {
    console.log("\n2. initializing with the deployer as interim admin");
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

  if (needPropose) {
    console.log("\n3. proposing the vault as config authority");
    const sig = await program.methods
      .proposeAuthority(vault)
      .accountsPartial({ config: configPda, authority: deployer.publicKey })
      .rpc();
    console.log(`   ${sig}`);
  }

  const after = await readConfig(program);
  if (!after || !after.pendingAuthority.equals(vault)) fail("pending authority is not the vault after run 1; inspect with 'pnpm admin show'");

  console.log(`
Run 1 done. The program is live; the deployer is the interim admin and the
vault is proposed. Nothing irreversible has happened yet.

Next, in Squads:
  1. Build the acceptance transaction:
       ${acceptCmd}
  2. Import it (Transactions -> Import), approve and execute with the vault.
  3. Confirm with:  pnpm admin show --cluster mainnet   (authority must be the vault)
  4. Then hand over the IDL and upgrade authority:
       ${finalizeCmd}
`);
}

// --- run 2: verify acceptance, hand over IDL + upgrade authority -----------

async function finalizeRun(): Promise<void> {
  const deployer = loadDeployer();
  const program = makeProgram(deployer);
  printHeader(deployer, "run 2: finalize authorities");
  console.log("");
  console.log("preflight");

  await clusterCheck();

  const programInfo = await connection.getAccountInfo(programId);
  if (!programInfo?.executable) fail(`${programId.toBase58()} is not deployed; run without --finalize first`);
  ok("program is deployed");

  const config = await readConfig(program);
  if (!config) fail("config is not initialized; run without --finalize first");
  if (!config.authority.equals(vault)) {
    fail(
      `config authority is ${config.authority.toBase58()}, not the vault.\n` +
        (config.pendingAuthority.equals(vault)
          ? "The vault is proposed but has not executed accept_authority yet. Do that in Squads first."
          : `pending authority is ${short(config.pendingAuthority)}. Re-run run 1 to propose the vault.`),
    );
  }
  ok("vault has accepted the config authority (it can sign)", vault.toBase58());

  const ua = await readUpgradeAuthority();
  let needUpgradeAuthority = true;
  if (ua === "missing") fail("ProgramData account not found");
  if (ua && ua.equals(vault)) { needUpgradeAuthority = false; ok("upgrade authority is already the vault"); }
  else if (ua && ua.equals(deployer.publicKey)) ok("upgrade authority is the deployer; will transfer");
  else fail(`upgrade authority is ${short(ua)}; this deployer cannot transfer it`);

  const idlState = await readIdlAuthority();
  let needIdlAuthority = true;
  if (idlState.authority === "missing") { needIdlAuthority = false; console.log("  WARN no IDL account on chain; skipping IDL authority (run 'anchor idl init' later from the vault)"); }
  else if (idlState.authority.equals(vault)) { needIdlAuthority = false; ok("IDL authority is already the vault"); }
  else if (idlState.authority.equals(deployer.publicKey)) ok("IDL authority is the deployer; will transfer");
  else fail(`IDL authority is ${idlState.authority.toBase58()}; this deployer cannot transfer it`);

  console.log(`\n${checks} checks passed`);

  if (!live) {
    console.log(`
Dry run only. Re-run with --confirm to execute:
  ${needIdlAuthority ? `1. IDL authority     -> ${vault.toBase58()}` : "1. (IDL authority: already done)"}
  ${needUpgradeAuthority ? `2. upgrade authority -> ${vault.toBase58()}` : "2. (upgrade authority: already done)"}
  3. verify all three on chain
`);
    return;
  }

  /**
   * A failure here leaves the deployer holding an authority. Surface the
   * exact command to finish by hand rather than dying with a stack trace.
   */
  function step(label: string, manual: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      console.error(`\n${label} failed: ${(err as Error).message}`);
      console.error(`The program IS deployed and the deployer still holds this authority.`);
      console.error(`Re-run '${finalizeCmd}' (it resumes), or finish by hand:\n  ${manual}\n`);
      process.exit(1);
    }
  }
  const finalizeCmd = `pnpm deploy:prod --finalize --multisig ${vault.toBase58()} --keypair ${keypairPath} --confirm`;

  if (needIdlAuthority) {
    console.log("\n1. handing the IDL account to the vault");
    step(
      "IDL authority transfer",
      `anchor idl set-authority --new-authority ${vault.toBase58()} --program-id ${programId.toBase58()} --provider.cluster ${idlCluster} --provider.wallet ${keypairPath}`,
      () => anchorIdlSetAuthority({ cluster: idlCluster, keypairPath, programId: programId.toBase58(), newAuthority: vault.toBase58(), cwd: programRoot }),
    );
  }

  if (needUpgradeAuthority) {
    console.log("\n2. handing the upgrade authority to the vault");
    step(
      "Upgrade authority transfer",
      `solana program set-upgrade-authority ${programId.toBase58()} --new-upgrade-authority ${vault.toBase58()} --skip-new-upgrade-authority-signer-check --upgrade-authority ${keypairPath} -u <rpc>`,
      () => solanaSetUpgradeAuthority({ rpcUrl, keypairPath, programId: programId.toBase58(), newAuthority: vault.toBase58(), cwd: programRoot }),
    );
  }

  console.log("\n3. verifying");
  let bad = 0;
  const cfg = (await readConfig(program))!;
  const authorityOk = cfg.authority.equals(vault);
  console.log(`  ${authorityOk ? "ok  " : "FAIL"} swap admin is the vault — ${cfg.authority.toBase58()}`);
  if (!authorityOk) bad++;

  const ua2 = await readUpgradeAuthority();
  const upgradeOk = ua2 !== "missing" && !!ua2 && ua2.equals(vault);
  console.log(`  ${upgradeOk ? "ok  " : "FAIL"} upgrade authority is the vault — ${ua2 === "missing" ? "missing" : short(ua2)}`);
  if (!upgradeOk) bad++;

  const idl2 = await readIdlAuthority();
  if (idl2.authority !== "missing") {
    const idlOk = idl2.authority.equals(vault);
    console.log(`  ${idlOk ? "ok  " : "FAIL"} IDL authority is the vault — ${idl2.authority.toBase58()}`);
    if (!idlOk) bad++;
  }
  console.log(`  ok   treasury ${cfg.treasury.toBase58()}, fee ${cfg.swapFeeLamports.toNumber() / LAMPORTS_PER_SOL} SOL, split ${cfg.treasuryBps} bps`);

  if (bad > 0) {
    fail(`${bad} post-deploy check(s) FAILED — the deployer key may still hold power. Fix before announcing.`);
  }

  console.log(`
Done. The deployer key now has no privileges over this program.

Set on the site:
  NEXT_PUBLIC_CHIMP_SWAP_PROGRAM_ID=${programId.toBase58()}

Admin from here on (build, then import into Squads):
  pnpm admin set --fee-sol <n> --authority ${vault.toBase58()} --print --cluster mainnet
`);
}

(finalize ? finalizeRun() : bootstrap()).catch((err) => {
  console.error(err);
  process.exit(1);
});
