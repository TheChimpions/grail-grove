/**
 * Grail Grove admin CLI.
 *
 * Two modes:
 *   --keypair <path>     sign and send with a local keypair (devnet/testing,
 *                        or `initialize` which the upgrade authority runs once)
 *   --authority <pubkey> --print
 *                        build the unsigned transaction with the multisig
 *                        vault as fee payer and print it base58, ready to
 *                        paste into a Squads "import transaction" proposal.
 *
 * Commands:
 *   show
 *   init --authority <pk> --treasury <pk> --collection <pk> --fee-sol <n> --treasury-bps <n>
 *   set [--fee-sol <n>] [--treasury-bps <n>] [--treasury <pk>] [--paused true|false]
 *   propose-authority <pk>
 *   accept-authority
 *   eject <mint>
 *   eject-all
 *
 * Global:
 *   --cluster devnet|mainnet|localnet   builds the Helius URL from HELIUS_API_KEY
 *   --rpc <url>                         explicit endpoint (overrides --cluster)
 *   --program <pk>
 *   --yes                               skip the interactive mainnet confirmation
 * One of --cluster or --rpc is required: there is no implicit default cluster.
 * Sending (not --print) requires --keypair; the default Solana CLI keypair is
 * never picked up implicitly. Sends to mainnet ask for confirmation.
 */
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import idl from "../target/idl/grail_grove.json";
import type { GrailGrove } from "../target/types/grail_grove";

const TOKEN_METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const BPF_LOADER_UPGRADEABLE_ID = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const LOCALNET = "http://127.0.0.1:8899";

// --- arg parsing -----------------------------------------------------------

const argv = process.argv.slice(2);
const positional: string[] = [];
const flags = new Map<string, string>();
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(a.slice(2), next);
      i++;
    } else {
      flags.set(a.slice(2), "true");
    }
  } else {
    positional.push(a);
  }
}
const command = positional[0];
const flag = (name: string) => flags.get(name);
const requireFlag = (name: string): string => {
  const v = flag(name);
  if (!v) fail(`Missing --${name}`);
  return v!;
};
const pubkeyFlag = (name: string): PublicKey => new PublicKey(requireFlag(name));
const boolFlag = (name: string): boolean | null => {
  const v = flag(name);
  if (v === undefined) return null;
  if (v === "true") return true;
  if (v === "false") return false;
  return fail(`--${name} must be true or false`);
};
const solToLamports = (sol: string): BN => {
  const n = Number(sol);
  if (!Number.isFinite(n) || n < 0) fail(`Bad SOL amount: ${sol}`);
  return new BN(Math.round(n * LAMPORTS_PER_SOL));
};

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

// --- setup ----------------------------------------------------------------

/** HELIUS_API_KEY from the environment, falling back to the repo's .env. */
function heliusKey(): string | undefined {
  if (process.env.HELIUS_API_KEY) return process.env.HELIUS_API_KEY;
  const envPath = join(__dirname, "..", ".env");
  if (!existsSync(envPath)) return undefined;
  const match = readFileSync(envPath, "utf8").match(/^HELIUS_API_KEY=(.*)$/m);
  return match?.[1].replace(/^"|"$/g, "") || undefined;
}

/**
 * Resolve the RPC endpoint. `--cluster devnet|mainnet|localnet` is the easy
 * path: it builds the Helius URL from HELIUS_API_KEY (env or .env),
 * so no one has to paste a secret on the command line. `--rpc` overrides it.
 */
function resolveRpc(): string {
  const explicit = flag("rpc") ?? process.env.RPC_URL;
  if (explicit) {
    // A shell that lacks HELIUS_API_KEY interpolates an empty key, which the
    // provider rejects with a bare 401. Catch it here with a useful message.
    if (/[?&]api-key=(&|$)/.test(explicit)) {
      fail(
        "--rpc has an empty api-key (is HELIUS_API_KEY exported?). " +
          "Use --cluster devnet instead and the key is read from .env.",
      );
    }
    return explicit;
  }
  const cluster = flag("cluster");
  if (!cluster) fail("pass --cluster devnet|mainnet|localnet or --rpc <url>; there is no default");
  if (cluster === "localnet" || cluster === "local") return LOCALNET;
  const host = cluster === "devnet" ? "devnet" : "mainnet";
  const key = heliusKey();
  if (!key) {
    fail(`--cluster ${cluster} needs HELIUS_API_KEY in the environment or .env`);
  }
  return `https://${host}.helius-rpc.com/?api-key=${key}`;
}

const rpc = resolveRpc();
const connection = new Connection(rpc, "confirmed");
/** Never print the api key. */
const safeRpc = rpc.replace(/api-key=[^&]+/, "api-key=***");
const programId = new PublicKey(flag("program") ?? idl.address);
const printMode = flag("print") === "true";

let signer: Keypair | null = null;
let actor: PublicKey;
if (printMode) {
  actor = pubkeyFlag("authority");
} else if (command === "show" && !flag("keypair")) {
  actor = PublicKey.default; // read-only, nothing to sign
} else {
  const path =
    flag("keypair") ??
    fail("--keypair <path> is required to send a transaction (or build one with --authority <pk> --print)");
  signer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
  actor = signer.publicKey;
}

const wallet = signer
  ? new anchor.Wallet(signer)
  : ({ publicKey: actor, signTransaction: async (t: never) => t, signAllTransactions: async (t: never) => t } as unknown as anchor.Wallet);
const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
const program = new anchor.Program<GrailGrove>({ ...idl, address: programId.toBase58() } as GrailGrove, provider);

const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
const listingPda = (mint: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("listing"), mint.toBuffer()], programId)[0];
const masterEditionPda = (mint: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer(), Buffer.from("edition")],
    TOKEN_METADATA_PROGRAM_ID,
  )[0];

// --- output ----------------------------------------------------------------

async function emit(label: string, ixs: TransactionInstruction[]): Promise<void> {
  const tx = new Transaction();
  tx.feePayer = actor;
  tx.add(...ixs);
  if (printMode) {
    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    console.log(`\n# ${label}`);
    console.log(`# fee payer / signer: ${actor.toBase58()}`);
    console.log(`# paste into Squads → Transactions → Import (base58):`);
    console.log(bs58.encode(serialized));
    return;
  }
  await confirmMainnet(label);
  console.log(`sending to ${safeRpc} as ${actor.toBase58()}`);
  const sig = await provider.sendAndConfirm(tx, []);
  console.log(`${label}: ${sig}`);
}

/** A signed send to mainnet must be acknowledged interactively (or with --yes). */
async function confirmMainnet(label: string): Promise<void> {
  if (flag("yes") === "true") return;
  if ((await connection.getGenesisHash()) !== MAINNET_GENESIS) return;
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(
    `About to send "${label}" to MAINNET signed by ${actor.toBase58()}. Type mainnet to continue: `,
  );
  rl.close();
  if (answer.trim() !== "mainnet") fail("aborted");
}

// --- commands -------------------------------------------------------------

async function show(): Promise<void> {
  const config = await program.account.config.fetchNullable(configPda);
  console.log(`rpc:       ${safeRpc}`);
  console.log(`program:   ${programId.toBase58()}`);
  console.log(`config:    ${configPda.toBase58()}`);
  if (!config) {
    console.log("config not initialized on this cluster");
    return;
  }
  console.log(`authority: ${config.authority.toBase58()}`);
  console.log(`pending:   ${config.pendingAuthority.toBase58()}`);
  console.log(`treasury:  ${config.treasury.toBase58()}`);
  console.log(`collection:${config.collection.toBase58()}`);
  console.log(`fee:       ${config.swapFeeLamports.toNumber() / LAMPORTS_PER_SOL} SOL (${config.swapFeeLamports.toString()} lamports)`);
  console.log(`treasury share: ${config.treasuryBps} bps`);
  console.log(`paused:    ${config.paused}`);
  console.log(`active listings: ${config.activeListings.toString()}`);
  const listings = await program.account.listing.all();
  for (const l of listings) {
    const when = new Date(l.account.createdAt.toNumber() * 1000).toISOString();
    console.log(`  ${l.account.mint.toBase58()}  owner=${l.account.owner.toBase58()}  listed=${when}`);
  }
}

async function init(): Promise<void> {
  const [programData] = PublicKey.findProgramAddressSync([programId.toBuffer()], BPF_LOADER_UPGRADEABLE_ID);
  const ix = await program.methods
    .initialize({
      authority: pubkeyFlag("authority"),
      collection: pubkeyFlag("collection"),
      swapFeeLamports: solToLamports(requireFlag("fee-sol")),
      treasuryBps: Number(requireFlag("treasury-bps")),
    })
    .accountsPartial({
      config: configPda,
      payer: actor,
      treasury: pubkeyFlag("treasury"),
      program: programId,
      programData,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  await emit("initialize", [ix]);
}

async function set(): Promise<void> {
  const feeSol = flag("fee-sol");
  const bps = flag("treasury-bps");
  const treasury = flag("treasury");
  const args = {
    swapFeeLamports: feeSol !== undefined ? solToLamports(feeSol) : null,
    treasuryBps: bps !== undefined ? Number(bps) : null,
    paused: boolFlag("paused"),
  };
  if (Object.values(args).every((v) => v === null) && treasury === undefined) {
    fail("nothing to update");
  }
  const ix = await program.methods
    .updateConfig(args)
    .accountsPartial({
      config: configPda,
      authority: actor,
      newTreasury: treasury !== undefined ? new PublicKey(treasury) : null,
    })
    .instruction();
  await emit("update_config", [ix]);
}

async function proposeAuthority(): Promise<void> {
  const next = positional[1] ?? fail("usage: propose-authority <pubkey>");
  const ix = await program.methods
    .proposeAuthority(new PublicKey(next))
    .accountsPartial({ config: configPda, authority: actor })
    .instruction();
  await emit("propose_authority", [ix]);
}

async function acceptAuthority(): Promise<void> {
  const ix = await program.methods
    .acceptAuthority()
    .accountsPartial({ config: configPda, newAuthority: actor })
    .instruction();
  await emit("accept_authority", [ix]);
}

async function ejectIx(mint: PublicKey): Promise<TransactionInstruction> {
  const listing = await program.account.listing.fetch(listingPda(mint));
  return program.methods
    .eject()
    .accountsPartial({
      config: configPda,
      listing: listingPda(mint),
      owner: listing.owner,
      authority: actor,
      mint,
      masterEdition: masterEditionPda(mint),
      ownerTokenAccount: listing.tokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
      tokenMetadataProgram: TOKEN_METADATA_PROGRAM_ID,
    })
    .instruction();
}

async function eject(): Promise<void> {
  const mint = new PublicKey(positional[1] ?? fail("usage: eject <mint>"));
  await emit(`eject ${mint.toBase58()}`, [await ejectIx(mint)]);
}

/** Every open listing, batched a few per transaction. */
async function ejectAll(): Promise<void> {
  const listings = await program.account.listing.all();
  if (listings.length === 0) {
    console.log("no open listings");
    return;
  }
  const BATCH = 4;
  for (let i = 0; i < listings.length; i += BATCH) {
    const batch = listings.slice(i, i + BATCH);
    const ixs = await Promise.all(batch.map((l) => ejectIx(l.account.mint)));
    const label = `eject ${batch.map((l) => l.account.mint.toBase58()).join(", ")}`;
    await emit(label, ixs);
  }
}

const commands: Record<string, () => Promise<void>> = {
  show,
  init,
  set,
  "propose-authority": proposeAuthority,
  "accept-authority": acceptAuthority,
  eject,
  "eject-all": ejectAll,
};

const run = commands[command ?? ""];
if (!run) {
  console.error(`usage: admin <${Object.keys(commands).join("|")}> [flags]`);
  process.exit(1);
}
run().catch((err) => {
  console.error(err);
  process.exit(1);
});
