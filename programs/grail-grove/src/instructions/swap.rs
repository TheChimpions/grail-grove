use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer as SysTransfer};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer as TokenTransfer};
use anchor_spl::token::spl_token::state::AccountState;
use mpl_token_metadata::instructions::ThawDelegatedAccountCpiBuilder;

use crate::errors::GrailGroveError;
use crate::events::Swapped;
use crate::fee::split_fee;
use crate::metadata::assert_chimpion;
use crate::state::{Config, Listing, CONFIG_SEED, LISTING_SEED};

/// Taker gives one Chimpion for the listed Chimpion, 1-for-1, and pays the
/// flat swap fee. The fee is split between the treasury and the lister per
/// `config.treasury_bps`. Both NFTs move in the same transaction and the
/// Listing is closed with its rent refunded to the lister.
#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = !config.paused @ GrailGroveError::Paused,
    )]
    pub config: Box<Account<'info, Config>>,

    #[account(
        mut,
        close = lister,
        seeds = [LISTING_SEED, listed_mint.key().as_ref()],
        bump = listing.bump,
        constraint = listing.owner == lister.key() @ GrailGroveError::Unauthorized,
        constraint = listing.mint == listed_mint.key() @ GrailGroveError::TokenAccountMismatch,
    )]
    pub listing: Box<Account<'info, Listing>>,

    #[account(mut, constraint = taker.key() != listing.owner @ GrailGroveError::SelfSwap)]
    pub taker: Signer<'info>,

    /// CHECK: receives the lister share of the fee, the offered NFT and listing rent.
    #[account(mut)]
    pub lister: UncheckedAccount<'info>,

    /// CHECK: receives the treasury share of the fee.
    #[account(mut, address = config.treasury)]
    pub treasury: UncheckedAccount<'info>,

    // --- Listed NFT (lister → taker) ---
    pub listed_mint: Box<Account<'info, Mint>>,

    /// CHECK: master edition PDA of the listed mint (freeze authority).
    #[account(
        seeds = [
            b"metadata",
            mpl_token_metadata::ID.as_ref(),
            listed_mint.key().as_ref(),
            b"edition",
        ],
        seeds::program = mpl_token_metadata::ID,
        bump,
        owner = mpl_token_metadata::ID @ GrailGroveError::InvalidMetadataOwner,
    )]
    pub listed_master_edition: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = lister_listed_token_account.key() == listing.token_account
            @ GrailGroveError::TokenAccountMismatch,
        constraint = lister_listed_token_account.amount == 1 @ GrailGroveError::NotHoldingToken,
    )]
    pub lister_listed_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = taker,
        associated_token::mint = listed_mint,
        associated_token::authority = taker,
    )]
    pub taker_listed_token_account: Box<Account<'info, TokenAccount>>,

    // --- Offered NFT (taker → lister) ---
    #[account(
        constraint = offered_mint.key() != listed_mint.key() @ GrailGroveError::SameMint,
        constraint = offered_mint.supply == 1 && offered_mint.decimals == 0
            @ GrailGroveError::OfferedNotNft,
    )]
    pub offered_mint: Box<Account<'info, Mint>>,

    /// CHECK: metadata PDA of the offered mint; verified in handler.
    #[account(
        seeds = [b"metadata", mpl_token_metadata::ID.as_ref(), offered_mint.key().as_ref()],
        seeds::program = mpl_token_metadata::ID,
        bump,
        owner = mpl_token_metadata::ID @ GrailGroveError::InvalidMetadataOwner,
    )]
    pub offered_metadata: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = taker_offered_token_account.owner == taker.key() @ GrailGroveError::TokenAccountMismatch,
        constraint = taker_offered_token_account.mint == offered_mint.key() @ GrailGroveError::TokenAccountMismatch,
        constraint = taker_offered_token_account.amount == 1 @ GrailGroveError::NotHoldingToken,
    )]
    pub taker_offered_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = taker,
        associated_token::mint = offered_mint,
        associated_token::authority = lister,
    )]
    pub lister_offered_token_account: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,

    /// CHECK: Token Metadata program, pinned by address.
    #[account(address = mpl_token_metadata::ID)]
    pub token_metadata_program: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<Swap>, max_fee_lamports: u64) -> Result<()> {
    let config = &ctx.accounts.config;

    assert_chimpion(
        &ctx.accounts.offered_metadata.to_account_info(),
        &ctx.accounts.offered_mint.key(),
        &config.collection,
    )?;

    let fee = config.swap_fee_lamports;
    require!(fee <= max_fee_lamports, GrailGroveError::FeeAboveMax);
    let (treasury_fee, lister_fee) = split_fee(fee, config.treasury_bps)?;

    if treasury_fee > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                SysTransfer {
                    from: ctx.accounts.taker.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                },
            ),
            treasury_fee,
        )?;
    }
    if lister_fee > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                SysTransfer {
                    from: ctx.accounts.taker.to_account_info(),
                    to: ctx.accounts.lister.to_account_info(),
                },
            ),
            lister_fee,
        )?;
    }

    // Listed NFT: thaw (PDA is the delegate) then delegate-transfer to taker.
    let listed_mint_key = ctx.accounts.listed_mint.key();
    let bump = ctx.accounts.listing.bump;
    let seeds: &[&[u8]] = &[
        LISTING_SEED,
        listed_mint_key.as_ref(),
        std::slice::from_ref(&bump),
    ];
    let signer_seeds: &[&[&[u8]]] = &[seeds];

    if ctx.accounts.lister_listed_token_account.state == AccountState::Frozen {
        let token_metadata_ai = ctx.accounts.token_metadata_program.to_account_info();
        let listing_ai = ctx.accounts.listing.to_account_info();
        let token_account_ai = ctx.accounts.lister_listed_token_account.to_account_info();
        let edition_ai = ctx.accounts.listed_master_edition.to_account_info();
        let mint_ai = ctx.accounts.listed_mint.to_account_info();
        let token_program_ai = ctx.accounts.token_program.to_account_info();

        ThawDelegatedAccountCpiBuilder::new(&token_metadata_ai)
            .delegate(&listing_ai)
            .token_account(&token_account_ai)
            .edition(&edition_ai)
            .mint(&mint_ai)
            .token_program(&token_program_ai)
            .invoke_signed(signer_seeds)?;
    }

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TokenTransfer {
                from: ctx.accounts.lister_listed_token_account.to_account_info(),
                to: ctx.accounts.taker_listed_token_account.to_account_info(),
                authority: ctx.accounts.listing.to_account_info(),
            },
            signer_seeds,
        ),
        1,
    )?;

    // Offered NFT: taker signs directly.
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TokenTransfer {
                from: ctx.accounts.taker_offered_token_account.to_account_info(),
                to: ctx.accounts.lister_offered_token_account.to_account_info(),
                authority: ctx.accounts.taker.to_account_info(),
            },
        ),
        1,
    )?;

    let config = &mut ctx.accounts.config;
    config.active_listings = config.active_listings.saturating_sub(1);

    emit!(Swapped {
        listed_mint: listed_mint_key,
        offered_mint: ctx.accounts.offered_mint.key(),
        lister: ctx.accounts.lister.key(),
        taker: ctx.accounts.taker.key(),
        fee_lamports: fee,
        treasury_fee_lamports: treasury_fee,
        lister_fee_lamports: lister_fee,
    });
    Ok(())
}
