import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  TokenStandard,
  burnNft,
  burnV1,
  mplTokenMetadata,
  revokeStandardV1,
  thawDelegatedAccount,
  transferV1,
  unlockV1,
} from "@metaplex-foundation/mpl-token-metadata";
import { keypairIdentity } from "@metaplex-foundation/umi";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import {
  fromWeb3JsKeypair,
  fromWeb3JsPublicKey,
} from "@metaplex-foundation/umi-web3js-adapters";

import type { MintedNft } from "./mint";

/**
 * Ways a holder might try to get a listed (frozen, delegated) legacy NFT out
 * from under the program through Token Metadata instead of `delist`. Each
 * one is expected to fail; they exist to prove the escrow holds.
 */

/** Umi resolves on a confirmed-but-failed transaction; make that a rejection. */
async function send(builder: { sendAndConfirm: (umi: any) => Promise<any> }, umi: unknown) {
  const res = await builder.sendAndConfirm(umi);
  if (res.result.value.err) {
    throw new Error(`transaction failed: ${JSON.stringify(res.result.value.err)}`);
  }
  return res;
}

function umiFor(connection: Connection, signer: Keypair) {
  const umi = createUmi(connection.rpcEndpoint).use(mplTokenMetadata());
  umi.use(keypairIdentity(fromWeb3JsKeypair(signer)));
  return umi;
}

export function unlockAsOwner(connection: Connection, owner: Keypair, nft: MintedNft) {
  const umi = umiFor(connection, owner);
  return send(unlockV1(umi, {
    authority: umi.identity,
    tokenOwner: umi.identity.publicKey,
    token: fromWeb3JsPublicKey(nft.ownerTokenAccount),
    mint: fromWeb3JsPublicKey(nft.mint),
    tokenStandard: TokenStandard.NonFungible,
  }), umi);
}

export function thawAsOwner(connection: Connection, owner: Keypair, nft: MintedNft) {
  const umi = umiFor(connection, owner);
  return send(thawDelegatedAccount(umi, {
    delegate: umi.identity,
    tokenAccount: fromWeb3JsPublicKey(nft.ownerTokenAccount),
    edition: fromWeb3JsPublicKey(nft.masterEdition),
    mint: fromWeb3JsPublicKey(nft.mint),
  }), umi);
}

export function revokeStandardAsOwner(
  connection: Connection,
  owner: Keypair,
  nft: MintedNft,
  delegate: PublicKey,
) {
  const umi = umiFor(connection, owner);
  return send(revokeStandardV1(umi, {
    delegate: fromWeb3JsPublicKey(delegate),
    mint: fromWeb3JsPublicKey(nft.mint),
    token: fromWeb3JsPublicKey(nft.ownerTokenAccount),
    authority: umi.identity,
    tokenOwner: umi.identity.publicKey,
    tokenStandard: TokenStandard.NonFungible,
  }), umi);
}

export function burnV1AsOwner(connection: Connection, owner: Keypair, nft: MintedNft) {
  const umi = umiFor(connection, owner);
  return send(burnV1(umi, {
    authority: umi.identity,
    tokenOwner: umi.identity.publicKey,
    mint: fromWeb3JsPublicKey(nft.mint),
    token: fromWeb3JsPublicKey(nft.ownerTokenAccount),
    edition: fromWeb3JsPublicKey(nft.masterEdition),
    tokenStandard: TokenStandard.NonFungible,
  }), umi);
}

export function burnNftAsOwner(connection: Connection, owner: Keypair, nft: MintedNft) {
  const umi = umiFor(connection, owner);
  return send(burnNft(umi, {
    owner: umi.identity,
    mint: fromWeb3JsPublicKey(nft.mint),
    metadata: fromWeb3JsPublicKey(nft.metadata),
    tokenAccount: fromWeb3JsPublicKey(nft.ownerTokenAccount),
    masterEditionAccount: fromWeb3JsPublicKey(nft.masterEdition),
  }), umi);
}

export function transferV1AsOwner(
  connection: Connection,
  owner: Keypair,
  nft: MintedNft,
  destinationOwner: PublicKey,
) {
  const umi = umiFor(connection, owner);
  return send(transferV1(umi, {
    authority: umi.identity,
    tokenOwner: umi.identity.publicKey,
    token: fromWeb3JsPublicKey(nft.ownerTokenAccount),
    destinationOwner: fromWeb3JsPublicKey(destinationOwner),
    mint: fromWeb3JsPublicKey(nft.mint),
    tokenStandard: TokenStandard.NonFungible,
  }), umi);
}
