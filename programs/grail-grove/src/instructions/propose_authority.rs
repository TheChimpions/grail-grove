use anchor_lang::prelude::*;

use crate::errors::GrailGroveError;
use crate::state::{Config, CONFIG_SEED};

/// Step 1 of a two-step authority handoff. The new authority must call
/// `accept_authority` before it takes effect, so a typo cannot brick admin.
#[derive(Accounts)]
pub struct ProposeAuthority<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ GrailGroveError::Unauthorized,
    )]
    pub config: Account<'info, Config>,
    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<ProposeAuthority>, new_authority: Pubkey) -> Result<()> {
    ctx.accounts.config.pending_authority = new_authority;
    Ok(())
}
