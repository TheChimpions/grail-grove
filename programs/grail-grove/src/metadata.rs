use anchor_lang::prelude::*;
use mpl_token_metadata::accounts::Metadata;
use mpl_token_metadata::types::TokenStandard;

use crate::errors::GrailGroveError;

/// Verify that `metadata_ai` describes `mint` and that the NFT is a verified
/// member of `collection`. Only legacy (non-programmable) NFTs are accepted:
/// the freeze/thaw escrow used by this program does not apply to pNFTs.
pub fn assert_chimpion(
    metadata_ai: &AccountInfo,
    mint: &Pubkey,
    collection: &Pubkey,
) -> Result<()> {
    let data = metadata_ai.try_borrow_data()?;
    let metadata = Metadata::from_bytes(&data)
        .map_err(|_| error!(GrailGroveError::MetadataDeserializeFailed))?;

    require_keys_eq!(metadata.mint, *mint, GrailGroveError::MetadataMintMismatch);

    match metadata.token_standard {
        None | Some(TokenStandard::NonFungible) => {}
        _ => return err!(GrailGroveError::UnsupportedTokenStandard),
    }

    let in_collection = metadata
        .collection
        .as_ref()
        .map(|c| c.verified && c.key == *collection)
        .unwrap_or(false);
    require!(in_collection, GrailGroveError::NotInCollection);

    Ok(())
}
