use anchor_lang::prelude::*;

pub const CONFIG_SEED: &[u8] = b"config";
pub const LISTING_SEED: &[u8] = b"listing";

pub const BPS_DENOMINATOR: u16 = 10_000;

/// Hard ceiling on the flat swap fee (1 SOL). The admin multisig can move the
/// fee anywhere below this; the cap only guards against a fat-fingered update.
pub const MAX_SWAP_FEE_LAMPORTS: u64 = 1_000_000_000;

/// Singleton program configuration, owned by the admin multisig.
#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Admin (Squads vault). Can update fees, pause, and eject any listing.
    pub authority: Pubkey,
    /// Two-step authority handoff target. `Pubkey::default()` when none.
    pub pending_authority: Pubkey,
    /// Receives `treasury_bps` of every swap fee.
    pub treasury: Pubkey,
    /// Verified Metaplex collection mint every listed/offered NFT must belong to.
    pub collection: Pubkey,
    /// Flat fee the taker pays on a successful swap.
    pub swap_fee_lamports: u64,
    /// Share of the fee (in basis points) routed to the treasury; the rest
    /// goes to the holder who posted the listing.
    pub treasury_bps: u16,
    /// When true, `list` and `swap` are blocked. `delist` and `eject` still work.
    pub paused: bool,
    /// Number of currently open listings.
    pub active_listings: u64,
    pub bump: u8,
}

/// One open swap listing. Seeds: ["listing", mint]. The NFT stays in the
/// owner's token account: this PDA is the SPL delegate and the account is
/// frozen via Token Metadata so it cannot move until delist/swap/eject.
#[account]
#[derive(InitSpace)]
pub struct Listing {
    pub owner: Pubkey,
    pub mint: Pubkey,
    /// Owner's token account holding the NFT at list time.
    pub token_account: Pubkey,
    pub created_at: i64,
    pub bump: u8,
}
