use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::token::{self, Approve, Mint, Token, TokenAccount};
use mpl_token_metadata::instructions::FreezeDelegatedAccountCpiBuilder;

use crate::errors::GrailGroveError;
use crate::events::Listed;
use crate::metadata::assert_chimpion;
use crate::state::{Config, Listing, CONFIG_SEED, LISTING_SEED};

/// Post a Chimpion for swap without giving up custody.
///
/// The owner approves the Listing PDA as SPL delegate for the single token,
/// then the PDA freezes the token account through Token Metadata
/// (`FreezeDelegatedAccount`, master edition = freeze authority). The NFT
/// stays in the owner's wallet but cannot be transferred, burned or closed
/// until `delist`, `swap` or `eject` thaws it.
#[derive(Accounts)]
pub struct List<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = !config.paused @ GrailGroveError::Paused,
    )]
    pub config: Box<Account<'info, Config>>,

    #[account(
        init,
        payer = owner,
        space = 8 + Listing::INIT_SPACE,
        seeds = [LISTING_SEED, mint.key().as_ref()],
        bump,
    )]
    pub listing: Box<Account<'info, Listing>>,

    #[account(mut)]
    pub owner: Signer<'info>,

    /// Single-supply NFT whose freeze authority is its master edition. Both
    /// are implied by a verified collection member with an edition account,
    /// but are asserted here so the invariant is stated in this program and
    /// fails with a clear error rather than a Token Metadata CPI error.
    #[account(
        constraint = mint.supply == 1 && mint.decimals == 0 @ GrailGroveError::NotNft,
        constraint = mint.freeze_authority == COption::Some(master_edition.key())
            @ GrailGroveError::InvalidFreezeAuthority,
    )]
    pub mint: Box<Account<'info, Mint>>,

    /// CHECK: Metaplex metadata PDA; seeds + owner enforced, contents parsed in handler.
    #[account(
        seeds = [b"metadata", mpl_token_metadata::ID.as_ref(), mint.key().as_ref()],
        seeds::program = mpl_token_metadata::ID,
        bump,
        owner = mpl_token_metadata::ID @ GrailGroveError::InvalidMetadataOwner,
    )]
    pub metadata: UncheckedAccount<'info>,

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
        constraint = owner_token_account.owner == owner.key() @ GrailGroveError::TokenAccountMismatch,
        constraint = owner_token_account.mint == mint.key() @ GrailGroveError::TokenAccountMismatch,
        constraint = owner_token_account.amount == 1 @ GrailGroveError::NotHoldingToken,
    )]
    pub owner_token_account: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,

    /// CHECK: Token Metadata program, pinned by address.
    #[account(address = mpl_token_metadata::ID)]
    pub token_metadata_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<List>) -> Result<()> {
    assert_chimpion(
        &ctx.accounts.metadata.to_account_info(),
        &ctx.accounts.mint.key(),
        &ctx.accounts.config.collection,
    )?;

    token::approve(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Approve {
                to: ctx.accounts.owner_token_account.to_account_info(),
                delegate: ctx.accounts.listing.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        1,
    )?;

    let mint_key = ctx.accounts.mint.key();
    let bump = ctx.bumps.listing;
    let seeds: &[&[u8]] = &[LISTING_SEED, mint_key.as_ref(), std::slice::from_ref(&bump)];

    let token_metadata_ai = ctx.accounts.token_metadata_program.to_account_info();
    let listing_ai = ctx.accounts.listing.to_account_info();
    let token_account_ai = ctx.accounts.owner_token_account.to_account_info();
    let edition_ai = ctx.accounts.master_edition.to_account_info();
    let mint_ai = ctx.accounts.mint.to_account_info();
    let token_program_ai = ctx.accounts.token_program.to_account_info();

    FreezeDelegatedAccountCpiBuilder::new(&token_metadata_ai)
        .delegate(&listing_ai)
        .token_account(&token_account_ai)
        .edition(&edition_ai)
        .mint(&mint_ai)
        .token_program(&token_program_ai)
        .invoke_signed(&[seeds])?;

    let now = Clock::get()?.unix_timestamp;
    let treasury_bps = ctx.accounts.config.treasury_bps;
    let listing = &mut ctx.accounts.listing;
    listing.owner = ctx.accounts.owner.key();
    listing.mint = mint_key;
    listing.token_account = ctx.accounts.owner_token_account.key();
    listing.created_at = now;
    listing.treasury_bps = treasury_bps;
    listing.bump = bump;

    let config = &mut ctx.accounts.config;
    config.active_listings = config
        .active_listings
        .checked_add(1)
        .ok_or(GrailGroveError::MathOverflow)?;

    emit!(Listed {
        mint: mint_key,
        owner: listing.owner,
        token_account: listing.token_account,
        created_at: now,
        treasury_bps,
    });
    Ok(())
}
