import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  TokenStandard,
  createV1,
  findMetadataPda,
  findMasterEditionPda,
  mintV1,
  mplTokenMetadata,
  verifyCollectionV1,
} from "@metaplex-foundation/mpl-token-metadata";
import {
  generateSigner,
  keypairIdentity,
  percentAmount,
  none,
  some,
} from "@metaplex-foundation/umi";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import {
  fromWeb3JsKeypair,
  fromWeb3JsPublicKey,
  toWeb3JsPublicKey,
} from "@metaplex-foundation/umi-web3js-adapters";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

export interface MintedNft {
  mint: PublicKey;
  metadata: PublicKey;
  masterEdition: PublicKey;
  /** Owner's associated token account holding the single token. */
  ownerTokenAccount: PublicKey;
}

interface MintParams {
  connection: Connection;
  /** Defaults to NonFungible (legacy); pass ProgrammableNonFungible for pNFT tests. */
  tokenStandard?: TokenStandard;
  /** Pays for the mint and is the (verified) creator. */
  authority: Keypair;
  /** Wallet that ends up holding the token. */
  owner: PublicKey;
  /** When set, the NFT is minted into this collection and verified. */
  collectionMint?: PublicKey;
  collectionAuthority?: Keypair;
  name?: string;
}

/** Mint a Metaplex collection parent NFT owned by `authority`. */
export async function createCollectionNft(
  connection: Connection,
  authority: Keypair,
  name = "Grail Grove Test Collection",
): Promise<PublicKey> {
  const umi = createUmi(connection.rpcEndpoint).use(mplTokenMetadata());
  umi.use(keypairIdentity(fromWeb3JsKeypair(authority)));

  const mint = generateSigner(umi);
  await createV1(umi, {
    mint,
    authority: umi.identity,
    payer: umi.identity,
    name,
    uri: "https://example.com/collection.json",
    sellerFeeBasisPoints: percentAmount(0),
    tokenStandard: TokenStandard.NonFungible,
    isCollection: true,
  }).sendAndConfirm(umi);

  await mintV1(umi, {
    mint: mint.publicKey,
    authority: umi.identity,
    amount: 1,
    tokenOwner: umi.identity.publicKey,
    tokenStandard: TokenStandard.NonFungible,
  }).sendAndConfirm(umi);

  return toWeb3JsPublicKey(mint.publicKey);
}

/** Programmable NFT (frozen by Token Metadata, transfers gated by token records). */
export function mintPnft(params: MintParams): Promise<MintedNft> {
  return mintLegacyNft({ ...params, tokenStandard: TokenStandard.ProgrammableNonFungible });
}

/**
 * Mint a legacy (NonFungible) Metaplex NFT with a master edition, matching
 * how the Chimpions were minted: master edition is the freeze authority.
 */
export async function mintLegacyNft(params: MintParams): Promise<MintedNft> {
  const {
    connection,
    authority,
    owner,
    collectionMint,
    collectionAuthority,
    name = "Test Chimpion",
    tokenStandard = TokenStandard.NonFungible,
  } = params;

  const umi = createUmi(connection.rpcEndpoint).use(mplTokenMetadata());
  umi.use(keypairIdentity(fromWeb3JsKeypair(authority)));

  const mint = generateSigner(umi);

  await createV1(umi, {
    mint,
    authority: umi.identity,
    payer: umi.identity,
    name,
    uri: "https://example.com/nft.json",
    sellerFeeBasisPoints: percentAmount(5, 2),
    tokenStandard,
    creators: [{ address: umi.identity.publicKey, share: 100, verified: true }],
    collection: collectionMint
      ? some({ key: fromWeb3JsPublicKey(collectionMint), verified: false })
      : none(),
  }).sendAndConfirm(umi);

  await mintV1(umi, {
    mint: mint.publicKey,
    authority: umi.identity,
    amount: 1,
    tokenOwner: fromWeb3JsPublicKey(owner),
    tokenStandard,
  }).sendAndConfirm(umi);

  const [metadataPda] = findMetadataPda(umi, { mint: mint.publicKey });
  const [masterEditionPda] = findMasterEditionPda(umi, { mint: mint.publicKey });

  if (collectionMint && collectionAuthority) {
    const collectionUmi = createUmi(connection.rpcEndpoint).use(mplTokenMetadata());
    collectionUmi.use(keypairIdentity(fromWeb3JsKeypair(collectionAuthority)));
    await verifyCollectionV1(collectionUmi, {
      metadata: metadataPda,
      collectionMint: fromWeb3JsPublicKey(collectionMint),
      authority: collectionUmi.identity,
    }).sendAndConfirm(collectionUmi);
  }

  const web3Mint = toWeb3JsPublicKey(mint.publicKey);
  return {
    mint: web3Mint,
    metadata: toWeb3JsPublicKey(metadataPda),
    masterEdition: toWeb3JsPublicKey(masterEditionPda),
    ownerTokenAccount: getAssociatedTokenAddressSync(web3Mint, owner),
  };
}
