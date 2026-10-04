import BN from "bn.js";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAccount as createTokenAccount,
  createAssociatedTokenAccountInstruction,
  createRevokeInstruction,
  createTransferInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { expect } from "chai";

import {
  TOKEN_METADATA_PROGRAM_ID,
  TestContext,
  expectRejects,
  fundedKeypair,
  listingPda,
  programDataPda,
  setupTestContext,
} from "./helpers/setup";
import { MintedNft, mintLegacyNft, mintPnft } from "./helpers/mint";

const SWAP_FEE = 10_000_000; // 0.01 SOL
const TREASURY_BPS = 5_000; // 50/50 split
const MAX_FEE = LAMPORTS_PER_SOL; // program constant MAX_SWAP_FEE_LAMPORTS

describe("grail_grove", () => {
  let ctx: TestContext;

  before(async () => {
    ctx = await setupTestContext();
  });

  // --- helpers -------------------------------------------------------------

  function mintTo(owner: PublicKey, inCollection = true): Promise<MintedNft> {
    return mintLegacyNft({
      connection: ctx.provider.connection,
      authority: ctx.upgradeAuthority,
      owner,
      collectionMint: inCollection ? ctx.collectionMint : undefined,
      collectionAuthority: inCollection ? ctx.upgradeAuthority : undefined,
    });
  }

  function initArgs() {
    return {
      authority: ctx.admin.publicKey,
      collection: ctx.collectionMint,
      swapFeeLamports: new BN(SWAP_FEE),
      treasuryBps: TREASURY_BPS,
    };
  }

  function initialize(
    payer: Keypair,
    args = initArgs(),
    treasury: PublicKey = ctx.treasury.publicKey,
  ) {
    const builder = ctx.program.methods.initialize(args).accountsPartial({
      config: ctx.config,
      payer: payer.publicKey,
      treasury,
      program: ctx.program.programId,
      programData: programDataPda(ctx.program.programId),
      systemProgram: SystemProgram.programId,
    });
    return payer.publicKey.equals(ctx.upgradeAuthority.publicKey)
      ? builder.rpc()
      : builder.signers([payer]).rpc();
  }

  type ConfigPatch = {
    swapFeeLamports?: BN | null;
    treasuryBps?: number | null;
    paused?: boolean | null;
    /** Passed as an account, not an arg: the program checks it is funded. */
    newTreasury?: PublicKey;
  };

  function updateConfig(signer: Keypair, patch: ConfigPatch) {
    const { newTreasury, ...args } = patch;
    return ctx.program.methods
      .updateConfig({
        swapFeeLamports: null,
        treasuryBps: null,
        paused: null,
        ...args,
      })
      .accountsPartial({
        config: ctx.config,
        authority: signer.publicKey,
        newTreasury: newTreasury ?? null,
      })
      .signers([signer])
      .rpc();
  }

  function list(owner: Keypair, nft: MintedNft) {
    return ctx.program.methods
      .list()
      .accountsPartial({
        config: ctx.config,
        listing: listingPda(ctx.program.programId, nft.mint),
        owner: owner.publicKey,
        mint: nft.mint,
        metadata: nft.metadata,
        masterEdition: nft.masterEdition,
        ownerTokenAccount: nft.ownerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        tokenMetadataProgram: TOKEN_METADATA_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();
  }

  function delist(owner: Keypair, nft: MintedNft) {
    return ctx.program.methods
      .delist()
      .accountsPartial({
        config: ctx.config,
        listing: listingPda(ctx.program.programId, nft.mint),
        owner: owner.publicKey,
        mint: nft.mint,
        masterEdition: nft.masterEdition,
        ownerTokenAccount: nft.ownerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        tokenMetadataProgram: TOKEN_METADATA_PROGRAM_ID,
      })
      .signers([owner])
      .rpc();
  }

  function swap(
    taker: Keypair,
    lister: PublicKey,
    listed: MintedNft,
    offered: MintedNft,
    maxFee: number,
    overrides: Record<string, PublicKey> = {},
  ) {
    return ctx.program.methods
      .swap(new BN(maxFee))
      .accountsPartial({
        config: ctx.config,
        listing: listingPda(ctx.program.programId, listed.mint),
        taker: taker.publicKey,
        lister,
        treasury: ctx.treasury.publicKey,
        listedMint: listed.mint,
        listedMasterEdition: listed.masterEdition,
        listerListedTokenAccount: listed.ownerTokenAccount,
        takerListedTokenAccount: getAssociatedTokenAddressSync(
          listed.mint,
          taker.publicKey,
        ),
        offeredMint: offered.mint,
        offeredMetadata: offered.metadata,
        takerOfferedTokenAccount: offered.ownerTokenAccount,
        listerOfferedTokenAccount: getAssociatedTokenAddressSync(
          offered.mint,
          lister,
        ),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        tokenMetadataProgram: TOKEN_METADATA_PROGRAM_ID,
        ...overrides,
      })
      .signers([taker])
      .rpc();
  }

  function eject(authority: Keypair, owner: PublicKey, nft: MintedNft) {
    return ctx.program.methods
      .eject()
      .accountsPartial({
        config: ctx.config,
        listing: listingPda(ctx.program.programId, nft.mint),
        owner,
        authority: authority.publicKey,
        mint: nft.mint,
        masterEdition: nft.masterEdition,
        ownerTokenAccount: nft.ownerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        tokenMetadataProgram: TOKEN_METADATA_PROGRAM_ID,
      })
      .signers([authority])
      .rpc();
  }

  /** Plain SPL transfer of `nft` from `from` to `to`, signed by `from`. */
  async function transferNft(from: Keypair, to: PublicKey, nft: MintedNft) {
    const dest = getAssociatedTokenAddressSync(nft.mint, to);
    const tx = new Transaction();
    const exists = await ctx.provider.connection.getAccountInfo(dest);
    if (!exists) {
      tx.add(
        createAssociatedTokenAccountInstruction(
          from.publicKey,
          dest,
          to,
          nft.mint,
        ),
      );
    }
    tx.add(
      createTransferInstruction(nft.ownerTokenAccount, dest, from.publicKey, 1),
    );
    return ctx.provider.sendAndConfirm(tx, [from]);
  }

  async function fetchConfig() {
    return ctx.program.account.config.fetch(ctx.config);
  }

  async function listingExists(nft: MintedNft) {
    const info = await ctx.provider.connection.getAccountInfo(
      listingPda(ctx.program.programId, nft.mint),
    );
    return info !== null;
  }

  const balance = (pk: PublicKey) => ctx.provider.connection.getBalance(pk);

  // --- initialize ----------------------------------------------------------

  describe("initialize", () => {
    it("rejects a payer that is not the program upgrade authority", async () => {
      const impostor = await fundedKeypair(ctx.provider, 2);
      await expectRejects(initialize(impostor), /NotUpgradeAuthority/);
    });

    it("rejects a fee above the hard cap", async () => {
      await expectRejects(
        initialize(ctx.upgradeAuthority, {
          ...initArgs(),
          swapFeeLamports: new BN(MAX_FEE + 1),
        }),
        /FeeTooHigh/,
      );
    });

    it("rejects a treasury share above 100%", async () => {
      await expectRejects(
        initialize(ctx.upgradeAuthority, { ...initArgs(), treasuryBps: 10_001 }),
        /InvalidBps/,
      );
    });

    it("rejects an unfunded treasury", async () => {
      await expectRejects(
        initialize(ctx.upgradeAuthority, initArgs(), Keypair.generate().publicKey),
        /InvalidTreasury/,
      );
    });

    it("rejects the default pubkey as treasury", async () => {
      await expectRejects(
        initialize(ctx.upgradeAuthority, initArgs(), PublicKey.default),
        /InvalidTreasury/,
      );
    });

    it("creates the config owned by the given authority", async () => {
      await initialize(ctx.upgradeAuthority);
      const config = await fetchConfig();
      expect(config.authority.toBase58()).to.equal(ctx.admin.publicKey.toBase58());
      expect(config.pendingAuthority.toBase58()).to.equal(PublicKey.default.toBase58());
      expect(config.treasury.toBase58()).to.equal(ctx.treasury.publicKey.toBase58());
      expect(config.collection.toBase58()).to.equal(ctx.collectionMint.toBase58());
      expect(config.swapFeeLamports.toNumber()).to.equal(SWAP_FEE);
      expect(config.treasuryBps).to.equal(TREASURY_BPS);
      expect(config.paused).to.equal(false);
      expect(config.activeListings.toNumber()).to.equal(0);
    });

    it("cannot be initialized twice", async () => {
      await expectRejects(initialize(ctx.upgradeAuthority), /already in use|0x0/);
    });
  });

  // --- admin config --------------------------------------------------------

  describe("update_config", () => {
    it("rejects a non-authority signer", async () => {
      const stranger = await fundedKeypair(ctx.provider, 1);
      await expectRejects(
        updateConfig(stranger, { swapFeeLamports: new BN(1) }),
        /Unauthorized/,
      );
    });

    it("rejects the upgrade authority once config exists (admin is the multisig)", async () => {
      await expectRejects(
        updateConfig(ctx.upgradeAuthority, { swapFeeLamports: new BN(1) }),
        /Unauthorized/,
      );
    });

    it("rejects a fee above the hard cap", async () => {
      await expectRejects(
        updateConfig(ctx.admin, { swapFeeLamports: new BN(MAX_FEE + 1) }),
        /FeeTooHigh/,
      );
    });

    it("rejects a treasury share above 100%", async () => {
      await expectRejects(updateConfig(ctx.admin, { treasuryBps: 10_001 }), /InvalidBps/);
    });

    it("rejects an unfunded or default treasury", async () => {
      await expectRejects(
        updateConfig(ctx.admin, { newTreasury: Keypair.generate().publicKey }),
        /InvalidTreasury/,
      );
      await expectRejects(
        updateConfig(ctx.admin, { newTreasury: PublicKey.default }),
        /InvalidTreasury/,
      );
      expect((await fetchConfig()).treasury.toBase58()).to.equal(
        ctx.treasury.publicKey.toBase58(),
      );
    });

    it("lets the authority change fee, split and treasury, leaving other fields alone", async () => {
      const newTreasury = (await fundedKeypair(ctx.provider, 1)).publicKey;
      await updateConfig(ctx.admin, {
        swapFeeLamports: new BN(SWAP_FEE * 2),
        treasuryBps: 2_500,
        newTreasury,
      });
      let config = await fetchConfig();
      expect(config.swapFeeLamports.toNumber()).to.equal(SWAP_FEE * 2);
      expect(config.treasuryBps).to.equal(2_500);
      expect(config.treasury.toBase58()).to.equal(newTreasury.toBase58());
      expect(config.paused).to.equal(false);

      // Restore for the rest of the suite.
      await updateConfig(ctx.admin, {
        swapFeeLamports: new BN(SWAP_FEE),
        treasuryBps: TREASURY_BPS,
        newTreasury: ctx.treasury.publicKey,
      });
      config = await fetchConfig();
      expect(config.swapFeeLamports.toNumber()).to.equal(SWAP_FEE);
      expect(config.treasuryBps).to.equal(TREASURY_BPS);
    });
  });

  describe("authority handoff", () => {
    it("requires the proposed authority to accept before it takes effect", async () => {
      const next = await fundedKeypair(ctx.provider, 2);
      const stranger = await fundedKeypair(ctx.provider, 1);

      await expectRejects(
        ctx.program.methods
          .proposeAuthority(next.publicKey)
          .accountsPartial({ config: ctx.config, authority: stranger.publicKey })
          .signers([stranger])
          .rpc(),
        /Unauthorized/,
      );

      await ctx.program.methods
        .proposeAuthority(next.publicKey)
        .accountsPartial({ config: ctx.config, authority: ctx.admin.publicKey })
        .signers([ctx.admin])
        .rpc();

      let config = await fetchConfig();
      expect(config.authority.toBase58()).to.equal(ctx.admin.publicKey.toBase58());
      expect(config.pendingAuthority.toBase58()).to.equal(next.publicKey.toBase58());

      await expectRejects(
        ctx.program.methods
          .acceptAuthority()
          .accountsPartial({ config: ctx.config, newAuthority: stranger.publicKey })
          .signers([stranger])
          .rpc(),
        /NotPendingAuthority/,
      );

      await ctx.program.methods
        .acceptAuthority()
        .accountsPartial({ config: ctx.config, newAuthority: next.publicKey })
        .signers([next])
        .rpc();

      config = await fetchConfig();
      expect(config.authority.toBase58()).to.equal(next.publicKey.toBase58());
      expect(config.pendingAuthority.toBase58()).to.equal(PublicKey.default.toBase58());

      // Old authority is locked out.
      await expectRejects(updateConfig(ctx.admin, { paused: true }), /Unauthorized/);

      // Hand it back so later tests keep using ctx.admin.
      await ctx.program.methods
        .proposeAuthority(ctx.admin.publicKey)
        .accountsPartial({ config: ctx.config, authority: next.publicKey })
        .signers([next])
        .rpc();
      await ctx.program.methods
        .acceptAuthority()
        .accountsPartial({ config: ctx.config, newAuthority: ctx.admin.publicKey })
        .signers([ctx.admin])
        .rpc();
      config = await fetchConfig();
      expect(config.authority.toBase58()).to.equal(ctx.admin.publicKey.toBase58());
    });

    it("rejects accept when nothing is pending", async () => {
      await expectRejects(
        ctx.program.methods
          .acceptAuthority()
          .accountsPartial({ config: ctx.config, newAuthority: ctx.admin.publicKey })
          .signers([ctx.admin])
          .rpc(),
        /NotPendingAuthority/,
      );
    });
  });

  // --- list ----------------------------------------------------------------

  describe("list", () => {
    it("freezes the NFT in the owner's wallet with the listing as delegate", async () => {
      const owner = await fundedKeypair(ctx.provider);
      const nft = await mintTo(owner.publicKey);
      const before = (await fetchConfig()).activeListings.toNumber();

      await list(owner, nft);

      const listing = await ctx.program.account.listing.fetch(
        listingPda(ctx.program.programId, nft.mint),
      );
      expect(listing.owner.toBase58()).to.equal(owner.publicKey.toBase58());
      expect(listing.mint.toBase58()).to.equal(nft.mint.toBase58());
      expect(listing.tokenAccount.toBase58()).to.equal(nft.ownerTokenAccount.toBase58());
      expect(listing.createdAt.toNumber()).to.be.greaterThan(0);

      const tokenAcc = await getAccount(ctx.provider.connection, nft.ownerTokenAccount);
      expect(tokenAcc.amount.toString()).to.equal("1");
      expect(tokenAcc.owner.toBase58()).to.equal(owner.publicKey.toBase58());
      expect(tokenAcc.isFrozen).to.equal(true);
      expect(tokenAcc.delegate?.toBase58()).to.equal(
        listingPda(ctx.program.programId, nft.mint).toBase58(),
      );
      expect(tokenAcc.delegatedAmount.toString()).to.equal("1");

      expect((await fetchConfig()).activeListings.toNumber()).to.equal(before + 1);

      // Owner cannot move the NFT while it is listed.
      const other = Keypair.generate().publicKey;
      await expectRejects(transferNft(owner, other, nft), /frozen|0x11/i);
    });

    it("rejects an NFT outside the collection", async () => {
      const owner = await fundedKeypair(ctx.provider);
      const nft = await mintTo(owner.publicKey, false);
      await expectRejects(list(owner, nft), /NotInCollection/);
    });

    it("rejects listing an NFT the signer does not hold", async () => {
      const holder = await fundedKeypair(ctx.provider);
      const impostor = await fundedKeypair(ctx.provider);
      const nft = await mintTo(holder.publicKey);
      await expectRejects(list(impostor, nft), /TokenAccountMismatch/);
    });

    it("rejects listing the same NFT twice", async () => {
      const owner = await fundedKeypair(ctx.provider);
      const nft = await mintTo(owner.publicKey);
      await list(owner, nft);
      await expectRejects(list(owner, nft), /already in use|0x0/);
    });

    it("accepts a non-associated token account that holds the NFT", async () => {
      const owner = await fundedKeypair(ctx.provider);
      const minted = await mintTo(owner.publicKey);
      const aux = await createTokenAccount(
        ctx.provider.connection,
        owner,
        minted.mint,
        owner.publicKey,
        Keypair.generate(),
      );
      await ctx.provider.sendAndConfirm(
        new Transaction().add(
          createTransferInstruction(minted.ownerTokenAccount, aux, owner.publicKey, 1),
        ),
        [owner],
      );
      const nft = { ...minted, ownerTokenAccount: aux };

      await list(owner, nft);
      const listing = await ctx.program.account.listing.fetch(
        listingPda(ctx.program.programId, nft.mint),
      );
      expect(listing.tokenAccount.toBase58()).to.equal(aux.toBase58());
      const tokenAcc = await getAccount(ctx.provider.connection, aux);
      expect(tokenAcc.isFrozen).to.equal(true);

      await delist(owner, nft);
      expect((await getAccount(ctx.provider.connection, aux)).isFrozen).to.equal(false);
    });

    it("is blocked while paused", async () => {
      const owner = await fundedKeypair(ctx.provider);
      const nft = await mintTo(owner.publicKey);
      await updateConfig(ctx.admin, { paused: true });
      try {
        await expectRejects(list(owner, nft), /Paused/);
      } finally {
        await updateConfig(ctx.admin, { paused: false });
      }
      await list(owner, nft);
      expect(await listingExists(nft)).to.equal(true);
    });
  });

  // --- delist --------------------------------------------------------------

  describe("delist", () => {
    it("rejects anyone but the listing owner", async () => {
      const owner = await fundedKeypair(ctx.provider);
      const stranger = await fundedKeypair(ctx.provider);
      const nft = await mintTo(owner.publicKey);
      await list(owner, nft);
      await expectRejects(delist(stranger, nft), /Unauthorized/);
      expect(await listingExists(nft)).to.equal(true);
    });

    it("thaws, revokes the delegate, closes the listing and refunds rent", async () => {
      const owner = await fundedKeypair(ctx.provider);
      const nft = await mintTo(owner.publicKey);
      await list(owner, nft);
      const activeBefore = (await fetchConfig()).activeListings.toNumber();
      const listingLamports = (await ctx.provider.connection.getAccountInfo(
        listingPda(ctx.program.programId, nft.mint),
      ))!.lamports;
      const ownerBefore = await balance(owner.publicKey);

      await delist(owner, nft);

      expect(await listingExists(nft)).to.equal(false);
      const tokenAcc = await getAccount(ctx.provider.connection, nft.ownerTokenAccount);
      expect(tokenAcc.isFrozen).to.equal(false);
      expect(tokenAcc.delegate).to.equal(null);
      expect(tokenAcc.amount.toString()).to.equal("1");
      expect((await fetchConfig()).activeListings.toNumber()).to.equal(activeBefore - 1);

      // Rent came back (minus the tx fee).
      const ownerAfter = await balance(owner.publicKey);
      expect(ownerAfter - ownerBefore).to.be.greaterThan(listingLamports - 10_000);

      // Owner is fully in control again and can re-list later.
      const other = await fundedKeypair(ctx.provider, 1);
      await transferNft(owner, other.publicKey, nft);
      const moved = await getAccount(
        ctx.provider.connection,
        getAssociatedTokenAddressSync(nft.mint, other.publicKey),
      );
      expect(moved.amount.toString()).to.equal("1");
    });

    it("still works while paused", async () => {
      const owner = await fundedKeypair(ctx.provider);
      const nft = await mintTo(owner.publicKey);
      await list(owner, nft);
      await updateConfig(ctx.admin, { paused: true });
      try {
        await delist(owner, nft);
      } finally {
        await updateConfig(ctx.admin, { paused: false });
      }
      expect(await listingExists(nft)).to.equal(false);
    });
  });

  // --- swap ----------------------------------------------------------------

  describe("swap", () => {
    it("exchanges the NFTs 1-for-1, splits the fee and closes the listing", async () => {
      const lister = await fundedKeypair(ctx.provider);
      const taker = await fundedKeypair(ctx.provider);
      const listed = await mintTo(lister.publicKey);
      const offered = await mintTo(taker.publicKey);
      await list(lister, listed);

      const listingKey = listingPda(ctx.program.programId, listed.mint);
      const listingLamports = (await ctx.provider.connection.getAccountInfo(listingKey))!.lamports;
      const activeBefore = (await fetchConfig()).activeListings.toNumber();
      const treasuryBefore = await balance(ctx.treasury.publicKey);
      const listerBefore = await balance(lister.publicKey);
      const takerBefore = await balance(taker.publicKey);

      await swap(taker, lister.publicKey, listed, offered, SWAP_FEE);

      const treasuryFee = Math.floor((SWAP_FEE * TREASURY_BPS) / 10_000);
      const listerFee = SWAP_FEE - treasuryFee;

      // Treasury receives exactly its share; nothing else touches it.
      expect((await balance(ctx.treasury.publicKey)) - treasuryBefore).to.equal(treasuryFee);
      // Lister receives its share plus the closed listing's rent (not a signer, so no tx fee).
      expect((await balance(lister.publicKey)) - listerBefore).to.equal(listerFee + listingLamports);
      // Taker paid at least the fee (plus tx fee and ATA rent).
      expect(takerBefore - (await balance(taker.publicKey))).to.be.greaterThan(SWAP_FEE);

      // Listed NFT is now in the taker's ATA, unfrozen, undelegated.
      const takerListed = await getAccount(
        ctx.provider.connection,
        getAssociatedTokenAddressSync(listed.mint, taker.publicKey),
      );
      expect(takerListed.amount.toString()).to.equal("1");
      expect(takerListed.isFrozen).to.equal(false);
      expect(takerListed.delegate).to.equal(null);

      // Lister's old token account is empty and thawed.
      const listerOld = await getAccount(ctx.provider.connection, listed.ownerTokenAccount);
      expect(listerOld.amount.toString()).to.equal("0");
      expect(listerOld.isFrozen).to.equal(false);

      // Offered NFT is now in the lister's ATA.
      const listerOffered = await getAccount(
        ctx.provider.connection,
        getAssociatedTokenAddressSync(offered.mint, lister.publicKey),
      );
      expect(listerOffered.amount.toString()).to.equal("1");
      const takerOld = await getAccount(ctx.provider.connection, offered.ownerTokenAccount);
      expect(takerOld.amount.toString()).to.equal("0");

      expect(await listingExists(listed)).to.equal(false);
      expect((await fetchConfig()).activeListings.toNumber()).to.equal(activeBefore - 1);

      // Both parties can move their new NFTs freely.
      const someone = await fundedKeypair(ctx.provider, 1);
      await transferNft(
        taker,
        someone.publicKey,
        { ...listed, ownerTokenAccount: getAssociatedTokenAddressSync(listed.mint, taker.publicKey) },
      );
    });

    it("routes rounding dust to the lister", async () => {
      await updateConfig(ctx.admin, { swapFeeLamports: new BN(1_001), treasuryBps: 3_333 });
      try {
        const lister = await fundedKeypair(ctx.provider);
        const taker = await fundedKeypair(ctx.provider);
        const listed = await mintTo(lister.publicKey);
        const offered = await mintTo(taker.publicKey);
        await list(lister, listed);
        const listingLamports = (await ctx.provider.connection.getAccountInfo(
          listingPda(ctx.program.programId, listed.mint),
        ))!.lamports;
        const treasuryBefore = await balance(ctx.treasury.publicKey);
        const listerBefore = await balance(lister.publicKey);

        await swap(taker, lister.publicKey, listed, offered, 1_001);

        // 1001 * 3333 / 10000 = 333.6 → 333 to treasury, 668 to lister
        expect((await balance(ctx.treasury.publicKey)) - treasuryBefore).to.equal(333);
        expect((await balance(lister.publicKey)) - listerBefore).to.equal(668 + listingLamports);
      } finally {
        await updateConfig(ctx.admin, {
          swapFeeLamports: new BN(SWAP_FEE),
          treasuryBps: TREASURY_BPS,
        });
      }
    });

    it("works with a zero fee", async () => {
      await updateConfig(ctx.admin, { swapFeeLamports: new BN(0) });
      try {
        const lister = await fundedKeypair(ctx.provider);
        const taker = await fundedKeypair(ctx.provider);
        const listed = await mintTo(lister.publicKey);
        const offered = await mintTo(taker.publicKey);
        await list(lister, listed);
        const treasuryBefore = await balance(ctx.treasury.publicKey);
        await swap(taker, lister.publicKey, listed, offered, 0);
        expect(await balance(ctx.treasury.publicKey)).to.equal(treasuryBefore);
        expect(await listingExists(listed)).to.equal(false);
      } finally {
        await updateConfig(ctx.admin, { swapFeeLamports: new BN(SWAP_FEE) });
      }
    });

    it("rejects when the fee rose above what the taker agreed to", async () => {
      const lister = await fundedKeypair(ctx.provider);
      const taker = await fundedKeypair(ctx.provider);
      const listed = await mintTo(lister.publicKey);
      const offered = await mintTo(taker.publicKey);
      await list(lister, listed);
      await expectRejects(
        swap(taker, lister.publicKey, listed, offered, SWAP_FEE - 1),
        /FeeAboveMax/,
      );
      expect(await listingExists(listed)).to.equal(true);
    });

    it("rejects an offered NFT outside the collection", async () => {
      const lister = await fundedKeypair(ctx.provider);
      const taker = await fundedKeypair(ctx.provider);
      const listed = await mintTo(lister.publicKey);
      const offered = await mintTo(taker.publicKey, false);
      await list(lister, listed);
      await expectRejects(
        swap(taker, lister.publicKey, listed, offered, SWAP_FEE),
        /NotInCollection/,
      );
      expect(await listingExists(listed)).to.equal(true);
    });

    it("rejects an offered NFT that is itself listed (frozen)", async () => {
      const lister = await fundedKeypair(ctx.provider);
      const taker = await fundedKeypair(ctx.provider);
      const listed = await mintTo(lister.publicKey);
      const offered = await mintTo(taker.publicKey);
      await list(lister, listed);
      await list(taker, offered);
      await expectRejects(
        swap(taker, lister.publicKey, listed, offered, SWAP_FEE),
        /frozen|0x11/i,
      );
      expect(await listingExists(listed)).to.equal(true);
      expect(await listingExists(offered)).to.equal(true);
    });

    it("rejects a programmable NFT as the offered NFT", async () => {
      const lister = await fundedKeypair(ctx.provider);
      const taker = await fundedKeypair(ctx.provider);
      const listed = await mintTo(lister.publicKey);
      const offered = await mintPnft({
        connection: ctx.provider.connection,
        authority: ctx.upgradeAuthority,
        owner: taker.publicKey,
        collectionMint: ctx.collectionMint,
        collectionAuthority: ctx.upgradeAuthority,
      });
      await list(lister, listed);
      await expectRejects(
        swap(taker, lister.publicKey, listed, offered, SWAP_FEE),
        /UnsupportedTokenStandard/,
      );
    });

    it("rejects an offered NFT the taker does not hold", async () => {
      const lister = await fundedKeypair(ctx.provider);
      const taker = await fundedKeypair(ctx.provider);
      const holder = await fundedKeypair(ctx.provider);
      const listed = await mintTo(lister.publicKey);
      const offered = await mintTo(holder.publicKey);
      await list(lister, listed);
      await expectRejects(
        swap(taker, lister.publicKey, listed, offered, SWAP_FEE),
        /TokenAccountMismatch/,
      );
    });

    it("rejects the lister swapping with their own listing", async () => {
      const lister = await fundedKeypair(ctx.provider);
      const listed = await mintTo(lister.publicKey);
      const offered = await mintTo(lister.publicKey);
      await list(lister, listed);
      await expectRejects(
        swap(lister, lister.publicKey, listed, offered, SWAP_FEE),
        /SelfSwap/,
      );
    });

    it("rejects a wrong lister account", async () => {
      const lister = await fundedKeypair(ctx.provider);
      const taker = await fundedKeypair(ctx.provider);
      const listed = await mintTo(lister.publicKey);
      const offered = await mintTo(taker.publicKey);
      await list(lister, listed);
      await expectRejects(
        swap(taker, taker.publicKey, listed, offered, SWAP_FEE),
        /Unauthorized/,
      );
    });

    it("rejects a wrong treasury account", async () => {
      const lister = await fundedKeypair(ctx.provider);
      const taker = await fundedKeypair(ctx.provider);
      const listed = await mintTo(lister.publicKey);
      const offered = await mintTo(taker.publicKey);
      await list(lister, listed);
      await expectRejects(
        swap(taker, lister.publicKey, listed, offered, SWAP_FEE, {
          treasury: taker.publicKey,
        }),
        /ConstraintAddress|address constraint/i,
      );
    });

    it("rejects swapping a listing for the same mint", async () => {
      const lister = await fundedKeypair(ctx.provider);
      const taker = await fundedKeypair(ctx.provider);
      const listed = await mintTo(lister.publicKey);
      const offered = await mintTo(taker.publicKey);
      await list(lister, listed);
      // The lister's "offered" ATA must derive from the (same) listed mint,
      // otherwise Anchor's ATA check fails before the program's SameMint guard.
      await expectRejects(
        swap(taker, lister.publicKey, listed, offered, SWAP_FEE, {
          offeredMint: listed.mint,
          offeredMetadata: listed.metadata,
          listerOfferedTokenAccount: listed.ownerTokenAccount,
        }),
        /SameMint/,
      );
    });

    it("is blocked while paused", async () => {
      const lister = await fundedKeypair(ctx.provider);
      const taker = await fundedKeypair(ctx.provider);
      const listed = await mintTo(lister.publicKey);
      const offered = await mintTo(taker.publicKey);
      await list(lister, listed);
      await updateConfig(ctx.admin, { paused: true });
      try {
        await expectRejects(
          swap(taker, lister.publicKey, listed, offered, SWAP_FEE),
          /Paused/,
        );
      } finally {
        await updateConfig(ctx.admin, { paused: false });
      }
      await swap(taker, lister.publicKey, listed, offered, SWAP_FEE);
      expect(await listingExists(listed)).to.equal(false);
    });

    it("cannot be executed twice for the same listing", async () => {
      const lister = await fundedKeypair(ctx.provider);
      const taker = await fundedKeypair(ctx.provider);
      const taker2 = await fundedKeypair(ctx.provider);
      const listed = await mintTo(lister.publicKey);
      const offered = await mintTo(taker.publicKey);
      const offered2 = await mintTo(taker2.publicKey);
      await list(lister, listed);
      await swap(taker, lister.publicKey, listed, offered, SWAP_FEE);
      await expectRejects(
        swap(taker2, lister.publicKey, listed, offered2, SWAP_FEE),
        /AccountNotInitialized|could not find|0xbc4/i,
      );
    });
  });

  // --- eject ---------------------------------------------------------------

  describe("eject", () => {
    it("rejects anyone but the config authority", async () => {
      const owner = await fundedKeypair(ctx.provider);
      const stranger = await fundedKeypair(ctx.provider);
      const nft = await mintTo(owner.publicKey);
      await list(owner, nft);
      await expectRejects(eject(stranger, owner.publicKey, nft), /Unauthorized/);
      await expectRejects(eject(owner, owner.publicKey, nft), /Unauthorized/);
      await expectRejects(eject(ctx.upgradeAuthority, owner.publicKey, nft), /Unauthorized/);
      expect(await listingExists(nft)).to.equal(true);
    });

    it("lets the authority eject a single listing and hands control back to the owner", async () => {
      const owner = await fundedKeypair(ctx.provider);
      const nft = await mintTo(owner.publicKey);
      await list(owner, nft);
      const activeBefore = (await fetchConfig()).activeListings.toNumber();
      const listingLamports = (await ctx.provider.connection.getAccountInfo(
        listingPda(ctx.program.programId, nft.mint),
      ))!.lamports;
      const ownerBefore = await balance(owner.publicKey);

      await eject(ctx.admin, owner.publicKey, nft);

      expect(await listingExists(nft)).to.equal(false);
      expect((await fetchConfig()).activeListings.toNumber()).to.equal(activeBefore - 1);
      // Rent refunded to the owner, who did not sign.
      expect((await balance(owner.publicKey)) - ownerBefore).to.equal(listingLamports);

      const tokenAcc = await getAccount(ctx.provider.connection, nft.ownerTokenAccount);
      expect(tokenAcc.isFrozen).to.equal(false);
      expect(tokenAcc.amount.toString()).to.equal("1");

      // The program can no longer act on the NFT: delist/swap need the listing.
      await expectRejects(delist(owner, nft), /AccountNotInitialized|could not find|0xbc4/i);

      // Owner can clear the leftover approval and move the NFT.
      await ctx.provider.sendAndConfirm(
        new Transaction().add(
          createRevokeInstruction(nft.ownerTokenAccount, owner.publicKey),
        ),
        [owner],
      );
      const cleared = await getAccount(ctx.provider.connection, nft.ownerTokenAccount);
      expect(cleared.delegate).to.equal(null);
      const other = await fundedKeypair(ctx.provider, 1);
      await transferNft(owner, other.publicKey, nft);
    });

    it("owner can re-list after an eject", async () => {
      const owner = await fundedKeypair(ctx.provider);
      const nft = await mintTo(owner.publicKey);
      await list(owner, nft);
      await eject(ctx.admin, owner.publicKey, nft);
      await list(owner, nft);
      const tokenAcc = await getAccount(ctx.provider.connection, nft.ownerTokenAccount);
      expect(tokenAcc.isFrozen).to.equal(true);
      expect(await listingExists(nft)).to.equal(true);
      await delist(owner, nft);
    });

    it("authority can unwind every listing one by one, even while paused", async () => {
      const owners = [
        await fundedKeypair(ctx.provider),
        await fundedKeypair(ctx.provider),
        await fundedKeypair(ctx.provider),
      ];
      const nfts: MintedNft[] = [];
      for (const owner of owners) {
        const nft = await mintTo(owner.publicKey);
        await list(owner, nft);
        nfts.push(nft);
      }
      await updateConfig(ctx.admin, { paused: true });
      try {
        for (let i = 0; i < nfts.length; i++) {
          await eject(ctx.admin, owners[i].publicKey, nfts[i]);
        }
      } finally {
        await updateConfig(ctx.admin, { paused: false });
      }

      for (let i = 0; i < nfts.length; i++) {
        expect(await listingExists(nfts[i])).to.equal(false);
        const tokenAcc = await getAccount(ctx.provider.connection, nfts[i].ownerTokenAccount);
        expect(tokenAcc.isFrozen).to.equal(false);
        expect(tokenAcc.owner.toBase58()).to.equal(owners[i].publicKey.toBase58());
        expect(tokenAcc.amount.toString()).to.equal("1");
      }

    });

    it("rejects a mismatched owner account", async () => {
      const owner = await fundedKeypair(ctx.provider);
      const other = await fundedKeypair(ctx.provider, 1);
      const nft = await mintTo(owner.publicKey);
      await list(owner, nft);
      await expectRejects(eject(ctx.admin, other.publicKey, nft), /TokenAccountMismatch/);
      expect(await listingExists(nft)).to.equal(true);
    });
  });
});
