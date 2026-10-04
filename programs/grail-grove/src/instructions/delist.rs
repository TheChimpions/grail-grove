use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Revoke, Token, TokenAccount};
use anchor_spl::token::spl_token::state::AccountState;
use mpl_token_metadata::instructions::ThawDelegatedAccountCpiBuilder;

use crate::errors::GrailGroveError;
use crate::events::Delisted;
use crate::state::{Config, Listing, CONFIG_SEED, LISTING_SEED};

/// Owner removes their listing: thaw the token account (Listing PDA signs as
/// the delegate), revoke the delegate, close the Listing and refund its rent.
#[derive(Accounts)]
pub struct Delist<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(
        mut,
        close = owner,
        seeds = [LISTING_SEED, mint.key().as_ref()],
        bump = listing.bump,
        has_one = owner @ GrailGroveError::Unauthorized,
        has_one = mint @ GrailGroveError::TokenAccountMismatch,
    )]
    pub listing: Box<Account<'info, Listing>>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub mint: Box<Account<'info, Mint>>,

    /// CHECK: master edition PDA (the mint's freeze authority).
    #[account(
        seeds = [
            b"metadata",
            mpl_token_metadata::ID.as_ref(),
            mint.key().as_ref(),
            b"edition",
        ],
        seeds::program = mpl_token_metadata::ID,
        bump,
        owner = mpl_token_metadata::ID @ GrailGroveError::InvalidMetadataOwner,
    )]
    pub master_edition: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = owner_token_account.key() == listing.token_account
            @ GrailGroveError::TokenAccountMismatch,
    )]
    pub owner_token_account: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,

    /// CHECK: Token Metadata program, pinned by address.
    #[account(address = mpl_token_metadata::ID)]
    pub token_metadata_program: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<Delist>) -> Result<()> {
    let mint_key = ctx.accounts.mint.key();
    let bump = ctx.accounts.listing.bump;
    let seeds: &[&[u8]] = &[LISTING_SEED, mint_key.as_ref(), std::slice::from_ref(&bump)];

    if ctx.accounts.owner_token_account.state == AccountState::Frozen {
        let token_metadata_ai = ctx.accounts.token_metadata_program.to_account_info();
        let listing_ai = ctx.accounts.listing.to_account_info();
        let token_account_ai = ctx.accounts.owner_token_account.to_account_info();
        let edition_ai = ctx.accounts.master_edition.to_account_info();
        let mint_ai = ctx.accounts.mint.to_account_info();
        let token_program_ai = ctx.accounts.token_program.to_account_info();

        ThawDelegatedAccountCpiBuilder::new(&token_metadata_ai)
            .delegate(&listing_ai)
            .token_account(&token_account_ai)
            .edition(&edition_ai)
            .mint(&mint_ai)
            .token_program(&token_program_ai)
            .invoke_signed(&[seeds])?;
    }

    if ctx.accounts.owner_token_account.delegate.is_some() {
        token::revoke(CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Revoke {
                source: ctx.accounts.owner_token_account.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ))?;
    }

    let config = &mut ctx.accounts.config;
    config.active_listings = config.active_listings.saturating_sub(1);

    emit!(Delisted {
        mint: mint_key,
        owner: ctx.accounts.owner.key(),
    });
    Ok(())
}
