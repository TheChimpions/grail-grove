/**
 * One-shot devnet environment for Grail Grove.
 *
 *   pnpm devnet:setup [--recipient <pk>[,<pk>...]] [--count <n>] [--offset <n>]
 *                     [--authority <pk>] [--treasury <pk>]
 *                     [--fee-sol <n>] [--treasury-bps <n>]
 *                     [--keypair <path>] [--skip-deploy] [--rpc <url>]
 *
 * 1. Funds a deployer keypair (.keys/devnet-deployer.json, created if missing).
 * 2. `anchor deploy` to devnet under the same program id as mainnet.
 * 3. Creates a devnet collection NFT and mints copies of the real Chimpions
 *    into it: same name, symbol, metadata URI (so art + traits are identical),
 *    royalty and creator list (unverified). Minted round-robin to --recipient
 *    (comma-separate two wallets: a swap needs a taker who is not the lister).
 * 4. Initializes the swap config for that collection.
 * 5. Prints the env vars the web app needs to run against devnet.
 *
 * Idempotent: progress is saved in .devnet/state.json, so re-running resumes
 * (e.g. to mint more chimps to a second wallet with --recipient/--offset).
 * The devnet faucet is rate-limited, so if SOL runs out the script mints what
 * it can afford, then prints the command to resume.
 * Mainnet metadata comes from Helius using HELIUS_API_KEY in .env.
 */
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  TokenStandard,
  createV1,
  findMetadataPda,
  mintV1,
  mplTokenMetadata,
  verifyCollectionV1,
} from "@metaplex-foundation/mpl-token-metadata";
import {
  generateSigner,
  keypairIdentity,
  percentAmount,
  publicKey as umiPk,
  some,
} from "@metaplex-foundation/umi";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { fromWeb3JsKeypair, toWeb3JsPublicKey } from "@metaplex-foundation/umi-web3js-adapters";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import idl from "../target/idl/grail_grove.json";
import type { GrailGrove } from "../target/types/grail_grove";

// tsx runs this as CommonJS (see tsconfig "module"), so __dirname is available.
const programRoot = join(__dirname, "..");
const PUBLIC_DEVNET_RPC = "https://api.devnet.solana.com";
const MAINNET_COLLECTION = "2k8iNEAB6EK8TyK2KtFdPzWp9tmW7dHpDbBhT6hPNMD8";
const DEFAULT_RECIPIENT = "nMnN7Lu8RxkoCAQ5jXGcoHkmPzEEHBGdfEpP6DNRT2Z";
const BPF_LOADER_UPGRADEABLE_ID = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
// The upgradeable loader reserves `--max-len` bytes for ProgramData and
// charges rent on all of it, so cap it at the current size plus room to grow
// rather than the default 2x (which costs ~5 SOL of scarce devnet SOL).
const DEPLOY_HEADROOM = 1.15;
// mint + metadata + master edition + ATA rent, plus fees, per chimp.
const MINT_COST_SOL = 0.013;
// Kept in the deployer so it can still pay for config init and fees.
const RESERVE_SOL = 0.05;

// --- args -----------------------------------------------------------------

const argv = process.argv.slice(2);
const flags = new Map<string, string>();
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith("--")) continue;
  const next = argv[i + 1];
  if (next !== undefined && !next.startsWith("--")) {
    flags.set(argv[i].slice(2), next);
    i++;
  } else {
    flags.set(argv[i].slice(2), "true");
  }
}
const flag = (k: string) => flags.get(k);

if (flags.has("help") || flags.has("h")) {
  console.log(`grail-grove devnet setup

  pnpm devnet:setup [options]

Deploys the program to devnet, mints a devnet clone of the Chimpions
collection (same names, art, traits and royalties) and initializes the swap
config. Resumable: progress is kept in .devnet/state.json, so re-run the same
command after topping the deployer up.

  --recipient <pk>[,<pk>]  wallets to mint to, round-robin
                           (default ${DEFAULT_RECIPIENT})
  --count <n>              how many chimps to mint (default 222)
  --offset <n>             skip the first n chimps, sorted by name (default 0)
  --authority <pk>         swap config admin (default: the deployer)
  --treasury <pk>          fee recipient, must be funded (default: the deployer)
  --fee-sol <n>            swap fee in SOL (default 0.01)
  --treasury-bps <n>       treasury's share of the fee (default 5000 = 50%)
  --keypair <path>         deployer keypair (default .keys/devnet-deployer.json)
  --rpc <url>              devnet RPC (default: Helius devnet, else public)
  --max-len <bytes>        ProgramData size to rent (default: +15% headroom).
                           Lower it to cut the deploy cost when devnet SOL is
                           scarce; it caps how much the program can grow.
  --skip-deploy            leave the deployed program alone
  --help

A swap needs a taker who is not the lister, so pass two wallets to test the
full flow, e.g. --recipient <yours>,<second>.
`);
  process.exit(0);
}

const recipients = (flag("recipient") ?? DEFAULT_RECIPIENT)
  .split(",")
  .map((r) => new PublicKey(r.trim()));
const count = Number(flag("count") ?? "222");
const offset = Number(flag("offset") ?? "0");
const feeSol = Number(flag("fee-sol") ?? "0.01");
const treasuryBps = Number(flag("treasury-bps") ?? "5000");
const keypairPath = flag("keypair") ?? join(programRoot, ".keys", "devnet-deployer.json");
const skipDeploy = flag("skip-deploy") === "true";

/** Rent-exempt minimum for `bytes` of account data, per the cluster itself. */
async function rentExemptSol(connection: Connection, bytes: number): Promise<number> {
  return (await connection.getMinimumBalanceForRentExemption(bytes)) / LAMPORTS_PER_SOL;
}

// --- state ----------------------------------------------------------------

interface State {
  collectionMint?: string;
  /** mainnet mint → devnet mint */
  minted: Record<string, string>;
  configInitialized?: boolean;
}
const stateDir = join(programRoot, ".devnet");
mkdirSync(stateDir, { recursive: true });

/**
 * State is keyed by the cluster's genesis hash, so a dry run against a local
 * validator can never be mistaken for progress on devnet (and a devnet reset
 * starts clean instead of reusing dead mint addresses).
 */
let statePath = join(stateDir, "state.json");
let state: State = { minted: {} };
function loadState(genesisHash: string) {
  statePath = join(stateDir, `state-${genesisHash.slice(0, 8)}.json`);
  state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { minted: {} };
}
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");

// --- helpers --------------------------------------------------------------

function loadEnvFile(): Record<string, string> {
  const p = join(programRoot, ".env");
  const out: Record<string, string> = {};
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^"|"$/g, "");
  }
  return out;
}

function loadOrCreateKeypair(path: string): Keypair {
  if (existsSync(path)) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
  }
  mkdirSync(dirname(path), { recursive: true });
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
  console.log(`created deployer keypair ${path} (${kp.publicKey.toBase58()})`);
  return kp;
}

/**
 * Top `who` up to `sol` SOL from the faucet. Devnet airdrops are 2 SOL a
 * request and aggressively rate-limited, so this is best-effort unless
 * `required` is set. Returns the balance it managed to reach.
 */
async function ensureFunded(
  connection: Connection,
  who: PublicKey,
  sol: number,
  required = true,
): Promise<number> {
  // requestAirdrop takes a u64, so every lamport amount here must be an
  // integer: `sol * LAMPORTS_PER_SOL` alone can land on a fraction.
  const targetLamports = Math.ceil(sol * LAMPORTS_PER_SOL);
  let balance = await connection.getBalance(who);
  if (balance >= targetLamports) return balance;
  console.log(`funding ${who.toBase58()}: have ${balance / LAMPORTS_PER_SOL} SOL, want ${sol} SOL`);
  for (let attempt = 0; attempt < 8 && balance < targetLamports; attempt++) {
    try {
      // Faucets cap a single airdrop (Helius devnet at 1 SOL), so top up in steps.
      const want = Math.min(LAMPORTS_PER_SOL, targetLamports - balance);
      const sig = await connection.requestAirdrop(who, Math.max(want, LAMPORTS_PER_SOL / 10));
      const latest = await connection.getLatestBlockhash();
      await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
    } catch (err) {
      console.log(`  airdrop attempt ${attempt + 1} failed: ${(err as Error).message.split("\n")[0]}`);
      await new Promise((r) => setTimeout(r, 5_000));
    }
    balance = await connection.getBalance(who);
  }
  if (required && balance < targetLamports) {
    throw new Error(
      `${who.toBase58()} has ${balance / LAMPORTS_PER_SOL} SOL but needs ${sol}. ` +
        `The devnet faucet is rate-limited — top it up at https://faucet.solana.com ` +
        `(or \`solana airdrop 2 ${who.toBase58()} -u devnet\`) and re-run; progress is saved.`,
    );
  }
  return balance;
}

/**
 * Wait until `who`'s balance is visible at finalized commitment. umi opens its
 * own RPC client, and a transaction built against a lagging bank fails with
 * "found no record of a prior credit" even though the payer is funded.
 */
async function waitForVisibleBalance(
  connection: Connection,
  who: PublicKey,
  timeoutMs = 60_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if ((await connection.getBalance(who, "finalized")) > 0) return;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`${who.toBase58()} still shows no finalized balance`);
}

/** Retry `fn`, backing off, unless the failure is terminal (out of funds). */
async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || isOutOfFunds(err)) throw err;
      console.log(`  retry ${attempt} for ${label}: ${(err as Error).message.split("\n")[0]}`);
      await new Promise((r) => setTimeout(r, 2_000 * attempt));
    }
  }
}

/** True when a failed transaction ran the deployer out of lamports. */
function isOutOfFunds(err: unknown): boolean {
  const text = err instanceof Error ? `${err.message} ${JSON.stringify((err as { logs?: string[] }).logs ?? [])}` : String(err);
  return /insufficient lamports|InsufficientFundsForRent|Attempt to debit/i.test(text);
}

interface MainnetChimp {
  id: string;
  name: string;
  symbol: string;
  uri: string;
  sellerFeeBasisPoints: number;
  creators: { address: string; share: number }[];
}

async function fetchMainnetChimps(apiKey: string): Promise<MainnetChimp[]> {
  const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "chimps",
      method: "getAssetsByGroup",
      params: { groupKey: "collection", groupValue: MAINNET_COLLECTION, limit: 1000, page: 1 },
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Helius: ${JSON.stringify(data.error)}`);
  const items = data.result.items as {
    id: string;
    content: { json_uri: string; metadata: { name: string; symbol?: string } };
    royalty: { basis_points: number };
    creators: { address: string; share: number }[];
  }[];
  return items
    .map((a) => ({
      id: a.id,
      name: a.content.metadata.name,
      symbol: a.content.metadata.symbol ?? "CHIMP",
      uri: a.content.json_uri,
      sellerFeeBasisPoints: a.royalty.basis_points,
      creators: a.creators,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// --- main -----------------------------------------------------------------

async function main() {
  const env = loadEnvFile();
  const heliusKey = process.env.HELIUS_API_KEY ?? env.HELIUS_API_KEY;
  if (!heliusKey) throw new Error("HELIUS_API_KEY not found in env or .env");

  const deployer = loadOrCreateKeypair(keypairPath);
  // The public devnet faucet is harshly rate-limited by IP; the Helius devnet
  // endpoint serves airdrops too and is far more reliable for bulk minting.
  const rpcUrl =
    flag("rpc") ?? (heliusKey ? `https://devnet.helius-rpc.com/?api-key=${heliusKey}` : PUBLIC_DEVNET_RPC);
  const connection = new Connection(rpcUrl, "confirmed");
  loadState(await connection.getGenesisHash());
  const programId = new PublicKey(idl.address);
  console.log(`rpc:      ${rpcUrl.replace(/api-key=[^&]+/, "api-key=***")}`);
  console.log(`deployer: ${deployer.publicKey.toBase58()}`);
  console.log(`program:  ${programId.toBase58()}`);
  console.log(`state:    ${statePath}`);

  // 1+2. deploy
  const programInfo = await connection.getAccountInfo(programId);
  if (skipDeploy) {
    console.log("skipping deploy (--skip-deploy)");
  } else {
    const soPath = join(programRoot, "target", "deploy", "grail_grove.so");
    const soLen = statSync(soPath).size;
    const maxLen = flag("max-len")
      ? Number(flag("max-len"))
      : Math.ceil((soLen * DEPLOY_HEADROOM) / 1024) * 1024;
    if (maxLen < soLen) throw new Error(`--max-len ${maxLen} is smaller than the program (${soLen})`);
    // Deploy first rents a temporary buffer, then rolls those lamports into
    // ProgramData, so the net cost is rent on maxLen plus per-write fees.
    const budget = (await rentExemptSol(connection, maxLen)) + 0.2;
    const verb = programInfo?.executable ? "upgrading" : "deploying";
    console.log(
      `${verb} ${soLen} bytes (max-len ${maxLen}); need ~${budget.toFixed(2)} SOL in the deployer`,
    );
    await ensureFunded(connection, deployer.publicKey, budget);
    execSync(
      `anchor deploy --provider.cluster ${rpcUrl} --provider.wallet ${keypairPath} -- --max-len ${maxLen}`,
      { cwd: programRoot, stdio: "inherit" },
    );
  }

  // Deploy drains most of the budget; make sure there is room for minting and
  // that the balance is visible to umi's own RPC client before continuing.
  await ensureFunded(connection, deployer.publicKey, 0.5, false);
  await waitForVisibleBalance(connection, deployer.publicKey);

  // 3. collection + chimps
  const umi = createUmi(rpcUrl).use(mplTokenMetadata());
  umi.use(keypairIdentity(fromWeb3JsKeypair(deployer)));

  if (!state.collectionMint) {
    const mint = generateSigner(umi);
    await withRetry("collection", () =>
        createV1(umi, {
        mint,
        authority: umi.identity,
        payer: umi.identity,
        name: "The Chimpions (devnet)",
        symbol: "CHIMP",
        uri: "https://arweave.net/Ss0Bf84U7mx-Xi_Udh_5YIHBZoXM-ZlQTbaI6ewIbp0",
        sellerFeeBasisPoints: percentAmount(0),
        tokenStandard: TokenStandard.NonFungible,
        isCollection: true,
      })
        .add(
          mintV1(umi, {
            mint: mint.publicKey,
            authority: umi.identity,
            amount: 1,
            tokenOwner: umi.identity.publicKey,
            tokenStandard: TokenStandard.NonFungible,
          }),
        )
        .sendAndConfirm(umi),
    );
    state.collectionMint = toWeb3JsPublicKey(mint.publicKey).toBase58();
    save();
    console.log(`collection: ${state.collectionMint}`);
  } else {
    console.log(`collection: ${state.collectionMint} (existing)`);
  }
  const collectionMint = umiPk(state.collectionMint);

  const chimps = (await fetchMainnetChimps(heliusKey)).slice(offset, offset + count);
  const todo = chimps.filter((c) => !state.minted[c.id]);

  // Mint only what the deployer can pay for; the faucet may not give more.
  await ensureFunded(connection, deployer.publicKey, todo.length * MINT_COST_SOL + RESERVE_SOL, false);
  const balanceSol = (await connection.getBalance(deployer.publicKey)) / LAMPORTS_PER_SOL;
  const affordable = Math.max(0, Math.floor((balanceSol - RESERVE_SOL) / MINT_COST_SOL));
  const batch = todo.slice(0, affordable);
  if (batch.length < todo.length) {
    console.log(
      `deployer has ${balanceSol.toFixed(3)} SOL: minting ${batch.length} of ${todo.length} remaining ` +
        `(~${MINT_COST_SOL} SOL each). Fund the deployer and re-run to continue.`,
    );
  }
  console.log(
    `minting ${batch.length} of ${chimps.length} chimps to ${recipients.map((r) => r.toBase58()).join(", ")}`,
  );

  const CONCURRENCY = 4;
  let cursor = 0;
  let done = 0;
  let outOfFunds = false;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, batch.length) }, async () => {
      while (cursor < batch.length && !outOfFunds) {
        const index = cursor++;
        const chimp = batch[index];
        const owner = recipients[index % recipients.length];
        for (let attempt = 1; ; attempt++) {
          try {
            const mint = generateSigner(umi);
            const [metadata] = findMetadataPda(umi, { mint: mint.publicKey });
            await createV1(umi, {
              mint,
              authority: umi.identity,
              payer: umi.identity,
              name: chimp.name,
              symbol: chimp.symbol,
              uri: chimp.uri,
              sellerFeeBasisPoints: percentAmount(chimp.sellerFeeBasisPoints / 100, 2),
              tokenStandard: TokenStandard.NonFungible,
              creators: chimp.creators.map((c) => ({
                address: umiPk(c.address),
                share: c.share,
                verified: false,
              })),
              collection: some({ key: collectionMint, verified: false }),
            })
              .add(
                mintV1(umi, {
                  mint: mint.publicKey,
                  authority: umi.identity,
                  amount: 1,
                  tokenOwner: umiPk(owner.toBase58()),
                  tokenStandard: TokenStandard.NonFungible,
                }),
              )
              .add(
                verifyCollectionV1(umi, {
                  metadata,
                  collectionMint,
                  authority: umi.identity,
                }),
              )
              .sendAndConfirm(umi);
            state.minted[chimp.id] = toWeb3JsPublicKey(mint.publicKey).toBase58();
            save();
            done++;
            console.log(
              `  [${done}/${batch.length}] ${chimp.name} → ${state.minted[chimp.id]} (${owner.toBase58().slice(0, 4)}…)`,
            );
            break;
          } catch (err) {
            if (isOutOfFunds(err)) {
              outOfFunds = true;
              console.log(`  out of SOL at ${chimp.name}; stopping cleanly`);
              break;
            }
            if (attempt >= 3) throw err;
            console.log(`  retry ${attempt} for ${chimp.name}: ${(err as Error).message.split("\n")[0]}`);
            await new Promise((r) => setTimeout(r, 2_000 * attempt));
          }
        }
      }
    }),
  );

  if (outOfFunds) {
    console.log(
      `\nStopped early: deployer ${deployer.publicKey.toBase58()} is out of SOL. ` +
        `Fund it and re-run the same command to continue.`,
    );
  }

  // 4. config
  await ensureFunded(connection, deployer.publicKey, 0.05, false);
  const wallet = new anchor.Wallet(deployer);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = new anchor.Program<GrailGrove>(idl as GrailGrove, provider);
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
  const existing = await program.account.config.fetchNullable(configPda);
  if (existing) {
    console.log(`config already initialized (authority ${existing.authority.toBase58()})`);
  } else {
    const authority = new PublicKey(flag("authority") ?? deployer.publicKey.toBase58());
    const treasury = new PublicKey(flag("treasury") ?? deployer.publicKey.toBase58());
    const [programData] = PublicKey.findProgramAddressSync([programId.toBuffer()], BPF_LOADER_UPGRADEABLE_ID);
    const sig = await program.methods
      .initialize({
        authority,
        collection: new PublicKey(state.collectionMint),
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
    console.log(`config initialized: ${sig}`);
    console.log(`  authority ${authority.toBase58()}  treasury ${treasury.toBase58()}  fee ${feeSol} SOL  split ${treasuryBps} bps`);
  }
  state.configInitialized = true;
  save();

  // 5. make sure the test wallets can pay fees and listing rent
  for (const who of recipients) {
    const balance = await ensureFunded(connection, who, 1, false);
    console.log(`recipient ${who.toBase58()}: ${(balance / LAMPORTS_PER_SOL).toFixed(3)} SOL`);
  }

  // 6. env. The RPC line keeps the key as a shell reference rather than
  // printing the secret into a terminal or CI log.
  const rpcLine = rpcUrl.includes("helius-rpc.com")
    ? "https://devnet.helius-rpc.com/?api-key=$HELIUS_API_KEY  # same key as .env"
    : rpcUrl;
  const isLocal = /127\.0\.0\.1|localhost/.test(rpcUrl);
  const clusterLine = isLocal
    ? "NEXT_PUBLIC_SOLANA_CLUSTER=devnet  # local validator: only affects explorer links"
    : "NEXT_PUBLIC_SOLANA_CLUSTER=devnet";
  console.log(`
Ready. Put this in the-chimpions/.env.development.local (or .env.local) to run the site against it:

${clusterLine}
NEXT_PUBLIC_HELIUS_RPC=${rpcLine}
NEXT_PUBLIC_COLLECTION_ADDRESS=${state.collectionMint}
NEXT_PUBLIC_CHIMP_SWAP_PROGRAM_ID=${programId.toBase58()}

Minted ${Object.keys(state.minted).length} chimps so far.

A swap needs a taker who is not the lister, so testing the full flow takes two
wallets. To mint to a second one:
  pnpm devnet:setup --skip-deploy --recipient <second-wallet> --offset 200 --count 10

Admin commands: pnpm admin <cmd> --rpc ${rpcUrl.replace(/api-key=[^&]+/, "api-key=$HELIUS_API_KEY")} --keypair ${keypairPath}
Deployer / devnet config authority: ${deployer.publicKey.toBase58()}
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
