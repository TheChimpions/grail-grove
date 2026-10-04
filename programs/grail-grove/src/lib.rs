#![allow(unexpected_cfgs)]
#![allow(ambiguous_glob_reexports)]

use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod fee;
pub mod instructions;
pub mod metadata;
pub mod state;

pub use errors::*;
pub use instructions::*;
pub use state::*;

declare_id!("6hXfvd34FyPaU3tRRhwxiWBLBLeb77GsTkXfpBGptUeC");

/// Non-custodial 1-for-1 swap board for The Chimpions.
///
/// Holders list a Chimpion (it stays in their wallet, frozen with the Listing
/// PDA as delegate). Another holder swaps one of their Chimpions for it and
/// pays a flat fee that is split between the treasury and the lister. An
/// admin multisig sets the fee, can pause the board, and can eject any
/// listing.
#[program]
pub mod grail_grove {
    use super::*;

    // --- Admin ---

    pub fn initialize(ctx: Context<Initialize>, args: InitializeArgs) -> Result<()> {
        instructions::initialize::handler(ctx, args)
    }

    pub fn update_config(ctx: Context<UpdateConfig>, args: UpdateConfigArgs) -> Result<()> {
        instructions::update_config::handler(ctx, args)
    }

    pub fn propose_authority(ctx: Context<ProposeAuthority>, new_authority: Pubkey) -> Result<()> {
        instructions::propose_authority::handler(ctx, new_authority)
    }

    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        instructions::accept_authority::handler(ctx)
    }

    pub fn eject(ctx: Context<Eject>) -> Result<()> {
        instructions::eject::handler(ctx)
    }

    // --- Holders ---

    pub fn list(ctx: Context<List>) -> Result<()> {
        instructions::list::handler(ctx)
    }

    pub fn delist(ctx: Context<Delist>) -> Result<()> {
        instructions::delist::handler(ctx)
    }

    pub fn swap(ctx: Context<Swap>, max_fee_lamports: u64) -> Result<()> {
        instructions::swap::handler(ctx, max_fee_lamports)
    }
}
