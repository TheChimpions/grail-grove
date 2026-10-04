use anchor_lang::prelude::*;

use crate::errors::GrailGroveError;
use crate::events::ConfigUpdated;
use crate::state::{Config, BPS_DENOMINATOR, CONFIG_SEED, MAX_SWAP_FEE_LAMPORTS};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct UpdateConfigArgs {
    pub swap_fee_lamports: Option<u64>,
    pub treasury_bps: Option<u16>,
    pub paused: Option<bool>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ GrailGroveError::Unauthorized,
    )]
    pub config: Account<'info, Config>,
    pub authority: Signer<'info>,

    /// CHECK: pass to change the fee recipient. Must already exist and be
    /// funded so fee transfers never fail the rent-exemption check.
    #[account(
        constraint = new_treasury.key() != Pubkey::default() && new_treasury.lamports() > 0
            @ GrailGroveError::InvalidTreasury,
    )]
    pub new_treasury: Option<UncheckedAccount<'info>>,
}

pub fn handler(ctx: Context<UpdateConfig>, args: UpdateConfigArgs) -> Result<()> {
    let config = &mut ctx.accounts.config;

    if let Some(fee) = args.swap_fee_lamports {
        require!(fee <= MAX_SWAP_FEE_LAMPORTS, GrailGroveError::FeeTooHigh);
        config.swap_fee_lamports = fee;
    }
    if let Some(bps) = args.treasury_bps {
        require!(bps <= BPS_DENOMINATOR, GrailGroveError::InvalidBps);
        config.treasury_bps = bps;
    }
    if let Some(treasury) = ctx.accounts.new_treasury.as_ref() {
        config.treasury = treasury.key();
    }
    if let Some(paused) = args.paused {
        config.paused = paused;
    }

    emit!(ConfigUpdated {
        swap_fee_lamports: config.swap_fee_lamports,
        treasury_bps: config.treasury_bps,
        treasury: config.treasury,
        paused: config.paused,
    });
    Ok(())
}
