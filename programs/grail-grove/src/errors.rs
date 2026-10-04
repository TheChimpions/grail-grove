use anchor_lang::prelude::*;

#[error_code]
pub enum GrailGroveError {
    #[msg("Caller is not the config authority")]
    Unauthorized,
    #[msg("Caller is not the pending authority")]
    NotPendingAuthority,
    #[msg("Swap fee exceeds the maximum allowed")]
    FeeTooHigh,
    #[msg("Treasury share must be between 0 and 10000 basis points")]
    InvalidBps,
    #[msg("Listings and swaps are paused")]
    Paused,
    #[msg("Payer is not the program upgrade authority")]
    NotUpgradeAuthority,
    #[msg("Metadata account is not owned by Token Metadata")]
    InvalidMetadataOwner,
    #[msg("Failed to deserialize token metadata")]
    MetadataDeserializeFailed,
    #[msg("Metadata does not belong to this mint")]
    MetadataMintMismatch,
    #[msg("NFT is not a verified member of the Chimpions collection")]
    NotInCollection,
    #[msg("Only legacy (non-programmable) NFTs are supported")]
    UnsupportedTokenStandard,
    #[msg("Token account does not hold exactly one token")]
    NotHoldingToken,
    #[msg("Token account does not match the listing")]
    TokenAccountMismatch,
    #[msg("Cannot swap a listing for the same mint")]
    SameMint,
    #[msg("Swap fee is higher than the maximum the taker agreed to pay")]
    FeeAboveMax,
    #[msg("Listing owner cannot swap with their own listing")]
    SelfSwap,
    #[msg("Treasury must be a funded account")]
    InvalidTreasury,
    #[msg("Offered mint is not a single-supply NFT")]
    OfferedNotNft,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Owner account does not match the listing")]
    OwnerMismatch,
    #[msg("Mint is not a single-supply NFT")]
    NotNft,
    #[msg("Mint freeze authority is not the master edition")]
    InvalidFreezeAuthority,
}
