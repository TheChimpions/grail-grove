use anchor_lang::prelude::*;

#[event]
pub struct Listed {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub token_account: Pubkey,
    pub created_at: i64,
}

#[event]
pub struct Delisted {
    pub mint: Pubkey,
    pub owner: Pubkey,
}

#[event]
pub struct Swapped {
    pub listed_mint: Pubkey,
    pub offered_mint: Pubkey,
    pub lister: Pubkey,
    pub taker: Pubkey,
    pub fee_lamports: u64,
    pub treasury_fee_lamports: u64,
    pub lister_fee_lamports: u64,
}

#[event]
pub struct Ejected {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub by: Pubkey,
}

#[event]
pub struct ConfigUpdated {
    pub swap_fee_lamports: u64,
    pub treasury_bps: u16,
    pub treasury: Pubkey,
    pub paused: bool,
}
