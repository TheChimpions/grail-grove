use anchor_lang::prelude::*;

use crate::errors::GrailGroveError;
use crate::events::ConfigUpdated;
use crate::state::{Config, BPS_DENOMINATOR, CONFIG_SEED, MAX_SWAP_FEE_LAMPORTS};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct InitializeArgs {
    pub authority: Pubkey,
    pub collection: Pubkey,
    pub swap_fee_lamports: u64,
    pub treasury_bps: u16,
}

/// One-time config creation. Only the program's upgrade authority may call
/// this, so nobody can front-run deployment and seize the admin role.
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: fee recipient. Must be a rent-exempt system account: a
    /// program-owned or executable account could strand fees or make every
    /// swap's system transfer fail.
    #[account(
        constraint = treasury.key() != Pubkey::default()
            && *treasury.owner == anchor_lang::system_program::ID
            && treasury.lamports() >= Rent::get()?.minimum_balance(0)
            @ GrailGroveError::InvalidTreasury,
    )]
    pub treasury: UncheckedAccount<'info>,

    #[account(constraint = program.programdata_address()? == Some(program_data.key()))]
    pub program: Program<'info, crate::program::GrailGrove>,

    #[account(
        constraint = program_data.upgrade_authority_address == Some(payer.key())
            @ GrailGroveError::NotUpgradeAuthority,
    )]
    pub program_data: Account<'info, ProgramData>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Initialize>, args: InitializeArgs) -> Result<()> {
    require!(
        args.swap_fee_lamports <= MAX_SWAP_FEE_LAMPORTS,
        GrailGroveError::FeeTooHigh
    );
    require!(
        args.treasury_bps <= BPS_DENOMINATOR,
        GrailGroveError::InvalidBps
    );

    let config = &mut ctx.accounts.config;
    config.authority = args.authority;
    config.pending_authority = Pubkey::default();
    config.treasury = ctx.accounts.treasury.key();
    config.collection = args.collection;
    config.swap_fee_lamports = args.swap_fee_lamports;
    config.treasury_bps = args.treasury_bps;
    config.paused = false;
    config.active_listings = 0;
    config.bump = ctx.bumps.config;

    emit!(ConfigUpdated {
        swap_fee_lamports: config.swap_fee_lamports,
        treasury_bps: config.treasury_bps,
        treasury: config.treasury,
        paused: config.paused,
    });
    Ok(())
}
