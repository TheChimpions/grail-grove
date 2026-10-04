import * as anchor from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";

import type { GrailGrove } from "../../target/types/grail_grove";
import { createCollectionNft } from "./mint";

export const CONFIG_SEED = Buffer.from("config");
export const LISTING_SEED = Buffer.from("listing");

export const BPF_LOADER_UPGRADEABLE_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);
export const TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
);

export function configPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], programId)[0];
}

export function listingPda(programId: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [LISTING_SEED, mint.toBuffer()],
    programId,
  )[0];
}

export function programDataPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE_ID,
  )[0];
}

export interface TestContext {
  provider: anchor.AnchorProvider;
  program: anchor.Program<GrailGrove>;
  /** Deployer of the program under `anchor test`; the only valid `initialize` payer. */
  upgradeAuthority: Keypair;
  /** Stand-in for the admin multisig. */
  admin: Keypair;
  treasury: Keypair;
  collectionMint: PublicKey;
  config: PublicKey;
}

export async function setupTestContext(): Promise<TestContext> {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.GrailGrove as anchor.Program<GrailGrove>;
  const upgradeAuthority = (provider.wallet as anchor.Wallet).payer;

  await waitForValidator(provider);

  // Clone-mode test validators do not auto-fund the provider wallet. Wait for
  // finality here because umi (which mints with this wallet) opens its own
  // RPC client and can otherwise read a stale balance.
  await airdropTo(provider, upgradeAuthority.publicKey, 500, "finalized");

  const admin = await fundedKeypair(provider, 10);
  const treasury = await fundedKeypair(provider, 1);
  const collectionMint = await createCollectionNft(
    provider.connection,
    upgradeAuthority,
  );

  return {
    provider,
    program,
    upgradeAuthority,
    admin,
    treasury,
    collectionMint,
    config: configPda(program.programId),
  };
}

/**
 * `anchor test` starts running as soon as the RPC answers, which can be
 * before the single-node cluster has finalized anything. Transactions sent
 * that early are simulated against a bank that does not yet know the
 * genesis-funded wallet ("no record of a prior credit"). Wait for the first
 * finalized slot before touching the chain.
 */
async function waitForValidator(
  provider: anchor.AnchorProvider,
  timeoutMs = 90_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const slot = await provider.connection.getSlot("finalized");
      if (slot > 0) return;
    } catch {
      // RPC not up yet
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error("Test validator never finalized a slot");
}

/** Top `target` up to at least `sol` SOL. */
export async function airdropTo(
  provider: anchor.AnchorProvider,
  target: PublicKey,
  sol: number,
  commitment: anchor.web3.Commitment = "confirmed",
): Promise<void> {
  const want = sol * LAMPORTS_PER_SOL;
  const current = await provider.connection.getBalance(target);
  if (current >= want) return;

  let amount = want - current;
  let attempts = 0;
  while (attempts < 5) {
    try {
      const sig = await provider.connection.requestAirdrop(target, amount);
      const latest = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction(
        { signature: sig, ...latest },
        commitment,
      );
      await waitForBalance(provider, target, want);
      return;
    } catch (err) {
      attempts++;
      amount = Math.floor(amount / 2);
      if (amount <= LAMPORTS_PER_SOL) {
        throw new Error(
          `Airdrop to ${target.toBase58()} failed after ${attempts} attempts: ${err}`,
        );
      }
    }
  }
}

/**
 * A confirmed airdrop can still be invisible to a client that opened its own
 * RPC connection a moment later (umi does). Poll until the balance shows.
 */
async function waitForBalance(
  provider: anchor.AnchorProvider,
  target: PublicKey,
  wantLamports: number,
  timeoutMs = 30_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const balance = await provider.connection.getBalance(target, "confirmed");
    if (balance >= wantLamports) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `Airdrop to ${target.toBase58()} never reached ${wantLamports / LAMPORTS_PER_SOL} SOL`,
  );
}

export async function fundedKeypair(
  provider: anchor.AnchorProvider,
  sol = 5,
): Promise<Keypair> {
  const kp = Keypair.generate();
  await airdropTo(provider, kp.publicKey, sol);
  return kp;
}

/** Await `p` and assert it rejects with an error whose text matches `pattern`. */
export async function expectRejects(
  p: Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  let failed = false;
  try {
    await p;
  } catch (err) {
    failed = true;
    const text = err instanceof Error ? `${err.message}\n${JSON.stringify((err as { logs?: string[] }).logs ?? [])}` : String(err);
    if (!pattern.test(text)) {
      throw new Error(`Expected error matching ${pattern}, got: ${text.slice(0, 600)}`);
    }
  }
  if (!failed) throw new Error(`Expected rejection matching ${pattern}, but it resolved`);
}
