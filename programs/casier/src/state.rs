use anchor_lang::prelude::*;
use anchor_spl::{ associated_token::AssociatedToken, token::{ Mint, Token, TokenAccount } };
#[derive(Accounts)]
pub struct Initialize {}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(seeds = [b"config".as_ref()], bump, has_one = admin, constraint = !config.is_frozen)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [ owner.key().as_ref() ],
        bump,
        has_one = owner,
    )]
    pub locker: Account<'info, Locker>,
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        has_one = owner,
        has_one = mint,
    )]
    pub user_ta: Account<'info, TokenAccount>,
    #[account(mut)]
    /// CHECK:
    pub vault_ta: UncheckedAccount<'info>,
    /// CHECK:
    #[account(mut)]
    pub burn_ta: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

pub struct PerformDeposit<'b, 'c, 'info> {
    pub config: &'b mut Account<'info, Config>,
    pub locker: &'c mut Account<'info, Locker>,
    pub mint: &'c AccountInfo<'info>,
    pub owner: &'b Signer<'info>,
    pub admin: &'b Signer<'info>,
    pub user_ta: &'c AccountInfo<'info>,
    pub vault_ta: &'c AccountInfo<'info>,
    pub burn_ta: &'c AccountInfo<'info>,
    pub system_program: &'b Program<'info, System>,
    pub token_program: &'b Program<'info, Token>,
    pub rent: &'b Sysvar<'info, Rent>,
}

pub struct PerformDepositV2<'b, 'c, 'info> {
    pub config: &'b mut Account<'info, Config>,
    pub locker: &'c mut Account<'info, Locker>,
    pub mint: &'c AccountInfo<'info>,
    pub owner: &'b Signer<'info>,
    pub admin: &'b Signer<'info>,
    pub user_ta: &'c AccountInfo<'info>,
    pub vault_ta: &'c AccountInfo<'info>,
    pub burn_ta: &'c AccountInfo<'info>,
    pub metadata: Option<&'c AccountInfo<'info>>,
    pub token_record: Option<&'c AccountInfo<'info>>,
    pub destination_token_record: Option<&'c AccountInfo<'info>>,
    pub edition: Option<&'c AccountInfo<'info>>,
    pub token_metadata_program: &'c AccountInfo<'info>,
    pub instructions: &'c AccountInfo<'info>,
    pub spl_ata_program_info: &'c AccountInfo<'info>,
    pub system_program: &'b Program<'info, System>,
    pub token_program: &'b Program<'info, Token>,
    pub rent: &'b Sysvar<'info, Rent>,
}

pub struct PerformWithdraw<'b, 'c, 'info> {
    pub config: &'b mut Account<'info, Config>,
    pub locker: &'c mut Account<'info, Locker>,
    pub mint: &'c AccountInfo<'info>,
    pub admin: &'b Signer<'info>,
    pub user_ta_owner: &'b Signer<'info>,
    pub user_ta: &'c AccountInfo<'info>,
    pub vault_ta: &'c AccountInfo<'info>,
    pub vault_ta_owner: &'c AccountInfo<'info>,
    pub burn_ta: &'c AccountInfo<'info>,
    pub system_program: &'b Program<'info, System>,
    pub token_program: &'b Program<'info, Token>,
    pub associated_token_program: &'b Program<'info, AssociatedToken>,
    pub rent: &'b Sysvar<'info, Rent>,
}

pub struct PerformWithdrawV2<'b, 'c, 'info> {
    pub config: &'b mut Account<'info, Config>,
    pub locker: &'c mut Account<'info, Locker>,
    pub mint: &'c AccountInfo<'info>,
    pub admin: &'b Signer<'info>,
    pub user_ta_owner: &'b Signer<'info>,
    pub user_ta: &'c AccountInfo<'info>,
    pub vault_ta: &'c AccountInfo<'info>,
    pub vault_ta_owner: &'c AccountInfo<'info>,
    pub burn_ta: &'c AccountInfo<'info>,
    pub metadata: Option<&'c AccountInfo<'info>>,
    pub token_record: Option<&'c AccountInfo<'info>>,
    pub destination_token_record: Option<&'c AccountInfo<'info>>,
    pub edition: Option<&'c AccountInfo<'info>>,
    pub token_metadata_program: &'c AccountInfo<'info>,
    pub instructions: &'c AccountInfo<'info>,
    pub system_program: &'b Program<'info, System>,
    pub token_program: &'b Program<'info, Token>,
    pub associated_token_program: &'b Program<'info, AssociatedToken>,
    pub rent: &'b Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct DepositBatch<'info> {
    #[account(seeds = [b"config".as_ref()], bump, has_one = admin, constraint = !config.is_frozen)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [ owner.key().as_ref() ],
        bump,
        has_one = owner,
    )]
    pub locker: Account<'info, Locker>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(seeds = [b"config".as_ref()], bump, has_one = admin, constraint = !config.is_frozen)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [ owner.key().as_ref() ],
        bump,
        has_one = owner,
    )]
    pub locker: Account<'info, Locker>,
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut)]
    /// CHECK:
    pub user_ta: UncheckedAccount<'info>,
    #[account(
        mut,
        has_one = mint,
        constraint = vault_ta.owner == vault_ta.key(),
    )]
    pub vault_ta: Account<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct WithdrawV2<'info> {
    #[account(seeds = [b"config".as_ref()], bump, has_one = admin, constraint = !config.is_frozen)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub locker: Account<'info, Locker>,
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut)]
    /// CHECK:
    pub user_ta: UncheckedAccount<'info>,
    #[account(mut)]
    pub user_ta_owner: Signer<'info>,
    /// CHECK:
    #[account(
        mut,
        // has_one = mint,
        // constraint = vault_ta.owner == vault_ta.key(),
    )]
    pub vault_ta: UncheckedAccount<'info>,
    /// CHECK:
    #[account(mut)]
    pub vault_ta_owner: AccountInfo<'info>,
    /// CHECK:
    #[account(mut)]
    pub burn_ta: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct WithdrawV2Batch<'info> {
    #[account(seeds = [b"config".as_ref()], bump, has_one = admin, constraint = !config.is_frozen)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub locker: Account<'info, Locker>,
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut)]
    pub user_ta_owner: Signer<'info>,
    /// CHECK:
    #[account(mut)]
    pub vault_ta_owner: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct WithdrawAndBurn<'info> {
    #[account(seeds = [b"config".as_ref()], bump, has_one = admin, constraint = !config.is_frozen)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [ owner.key().as_ref() ],
        bump,
        has_one = owner,
    )]
    pub locker: Account<'info, Locker>,
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut)]
    /// CHECK:
    pub user_ta: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK:
    pub burn_ta: UncheckedAccount<'info>,
    #[account(
        mut,
        has_one = mint,
        constraint = vault_ta.owner == vault_ta.key(),
    )]
    pub vault_ta: Account<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(init, seeds = [b"config".as_ref()], bump, payer = fee_payer, space = 8 + 32 + 1)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub fee_payer: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(_space: u64)]
pub struct InitLocker<'info> {
    #[account(init, seeds = [owner.key().as_ref()], bump, payer = owner, space = _space as usize)]
    pub locker: Account<'info, Locker>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(_space: u64)]
pub struct IncreaseLockerSize {
    // #[account(
    //     mut,
    //     seeds = [ fee_payer.key().as_ref() ],
    //     bump,
    //     realloc = _space
    //     payer = fee_payer,
    //     space = _space as usize
    // )]
    // locker: Account<'info, Locker>,
    // #[account(mut)]
    // fee_payer: Signer<'info>,
    // system_program: Program<'info, System>,
    // rent: Sysvar<'info, Rent>,
}

#[account]
#[derive(Default)]
pub struct Config {
    pub admin: Pubkey,
    pub is_frozen: bool,
}
#[account]
#[derive(Default)]
pub struct Locker {
    pub owner: Pubkey,
    pub mints: Vec<Pubkey>,
    pub amounts: Vec<u64>,
    pub version: u8,
    pub space: u64,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid vault.")]
    InvalidVault,
    #[msg("Invalid before state.")]
    InvalidBeforeState,
    #[msg("Invalid before state.")]
    InvalidBeforeState2,
    #[msg("Invalid before state.")]
    InvalidBeforeState3,
    #[msg("Invalid before state.")]
    InvalidBeforeState4,
    #[msg("Trying to withdraw a mint not in locker..")]
    WithdrawForMintNotInLocker,
    #[msg("InvalidFinalState: FinalState.")]
    InvalidFinalState,
    #[msg("BurnNotRequired")]
    BurnNotRequired,
    #[msg("BurnRequired")]
    BurnRequired,
    #[msg("InsufficientFunds")]
    InsufficientFunds,
    #[msg("Wrong remaining accounts size")]
    WrongRemainingAccountsSize,
    #[msg("Transfer failed.")]
    TransferFail,
}

pub enum WithdrawType {
    Owner,
    OwnerBurn,
    NonOwner,
    NonOwnerBurn,
}
