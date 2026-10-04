use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use anchor_spl::token::spl_token::state::AccountState;
use mpl_token_metadata::instructions::ThawDelegatedAccountCpiBuilder;

use crate::errors::GrailGroveError;
use crate::events::Ejected;
use crate::state::{Config, Listing, CONFIG_SEED, LISTING_SEED};

/// Force-close a listing and hand control of the NFT back to its owner.
/// Only the config authority (the admin multisig) may call this; the whole
/// book is unwound by calling it once per listing.
///
/// The token account is thawed and the Listing closed (rent → owner). The
/// SPL delegate approval itself can only be revoked by the owner; with the
/// Listing gone the program has no instruction that can sign for that PDA,
/// so the leftover approval is inert. The owner can clear it with a plain
/// SPL `revoke` at any time.
#[derive(Accounts)]
pub struct Eject<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ GrailGroveError::Unauthorized,
    )]
    pub config: Box<Account<'info, Config>>,

    #[account(
        mut,
        close = owner,
        seeds = [LISTING_SEED, mint.key().as_ref()],
        bump = listing.bump,
        has_one = owner @ GrailGroveError::OwnerMismatch,
        has_one = mint @ GrailGroveError::TokenAccountMismatch,
    )]
    pub listing: Box<Account<'info, Listing>>,

    /// CHECK: listing owner; receives the closed Listing's rent.
    #[account(mut)]
    pub owner: UncheckedAccount<'info>,

    pub authority: Signer<'info>,

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

pub fn handler(ctx: Context<Eject>) -> Result<()> {
    let mint_key = ctx.accounts.mint.key();
    let bump = ctx.accounts.listing.bump;
    let seeds: &[&[u8]] = &[LISTING_SEED, mint_key.as_ref(), std::slice::from_ref(&bump)];

    let is_our_delegate = ctx.accounts.owner_token_account.delegate
        == Some(ctx.accounts.listing.key()).into();

    if ctx.accounts.owner_token_account.state == AccountState::Frozen && is_our_delegate {
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

    let config = &mut ctx.accounts.config;
    // Saturating on purpose: this is a recovery path, and an informational
    // counter must never be able to trap an NFT. `swap` uses checked_sub so
    // any drift still surfaces.
    config.active_listings = config.active_listings.saturating_sub(1);

    emit!(Ejected {
        mint: mint_key,
        owner: ctx.accounts.owner.key(),
        by: ctx.accounts.authority.key(),
    });
    Ok(())
}
