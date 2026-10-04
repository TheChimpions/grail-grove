use anchor_lang::prelude::*;

use crate::errors::GrailGroveError;
use crate::state::{Config, CONFIG_SEED};

/// Step 2 of the authority handoff: the proposed authority signs to accept.
#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.pending_authority != Pubkey::default()
            && config.pending_authority == new_authority.key()
            @ GrailGroveError::NotPendingAuthority,
    )]
    pub config: Account<'info, Config>,
    pub new_authority: Signer<'info>,
}

pub fn handler(ctx: Context<AcceptAuthority>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.authority = config.pending_authority;
    config.pending_authority = Pubkey::default();
    Ok(())
}
