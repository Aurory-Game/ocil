pub mod state;
pub mod utils;

use crate::state::{ErrorCode, *};
use crate::utils::*;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{pubkey::Pubkey, rent::Rent};
use anchor_spl;
use anchor_spl::token::{Mint, TokenAccount};
// declare_id!("CAsieqooSrgVxhgWRwh21gyjq7Rmuhmo4qTW9XzXtAvW");
declare_id!("FLoc9nBwGb2ayzVzb5GC9NttuPY3CxMhd4KDnApr79Ab");

#[program]
pub mod casier {
    use anchor_lang::solana_program::system_program;
    use anchor_spl::{associated_token::AssociatedToken, token::Token};

    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        Ok(())
    }

    pub fn init_config(ctx: Context<InitConfig>) -> Result<()> {
        ctx.accounts.config.admin = ctx.accounts.fee_payer.key();
        ctx.accounts.config.is_frozen = false;
        Ok(())
    }

    pub fn init_locker(ctx: Context<InitLocker>, _space: u64) -> Result<()> {
        ctx.accounts.locker.owner = ctx.accounts.owner.key();
        ctx.accounts.locker.space = ctx.accounts.locker.to_account_info().data_len() as u64;
        Ok(())
    }

    pub fn increase_locker_size(ctx: Context<IncreaseLockerSize>, _new_size: u64) -> Result<()> {
        Ok(())
    }

    /*
     * Deposits deposit_amount into the vault if the current mint's amount in the locker is before_amount.
     * burn_ta is an admin controlled TA
     */
    pub fn deposit<'a, 'b, 'c, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, Deposit>,
        vault_bump: u8,
        deposit_amount: u64,
        before_amount: u64,
        burn_bump: u8,
        should_go_in_burn_ta: bool,
    ) -> Result<()> {
        perform_deposit(
            PerformDeposit {
                config: &mut ctx.accounts.config,
                locker: &mut ctx.accounts.locker,
                mint: &ctx.accounts.mint.to_account_info(),
                owner: &mut ctx.accounts.owner,
                admin: &mut ctx.accounts.admin,
                user_ta: &ctx.accounts.user_ta.to_account_info(),
                vault_ta: &ctx.accounts.vault_ta.to_account_info(),
                burn_ta: &ctx.accounts.burn_ta.to_account_info(),
                system_program: &mut ctx.accounts.system_program,
                token_program: &mut ctx.accounts.token_program,
                rent: &mut ctx.accounts.rent,
            },
            vault_bump,
            deposit_amount,
            before_amount,
            burn_bump,
            should_go_in_burn_ta,
        )?;
        Ok(())
    }

    pub fn deposit_batch<'a, 'b, 'c, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, DepositBatch<'info>>,
        deposit_amounts: Vec<u64>,
        before_amounts: Vec<u64>,
        vault_bumps: Vec<u8>,
        burn_bumps: Vec<u8>,
        should_go_in_burn_ta: bool,
    ) -> Result<()> {
        if ctx.remaining_accounts.len() % 4 != 0 {
            return Err(error!(ErrorCode::WrongRemainingAccountsSize));
        }
        let accounts: &'b mut DepositBatch<'info> = ctx.accounts;
        let config: &'b mut Account<'info, Config> = &mut accounts.config;
        let locker: &'b mut Account<'info, Locker> = &mut accounts.locker;
        let owner: &'b Signer<'info> = &accounts.owner;
        let admin: &'b Signer<'info> = &accounts.admin;
        let system_program: &'b Program<'info, System> = &accounts.system_program;
        let token_program: &'b Program<'info, Token> = &accounts.token_program;
        let rent: &'b Sysvar<'info, Rent> = &accounts.rent;
        let remaining_accounts: &'c [AccountInfo<'info>] = ctx.remaining_accounts;
        let mut index = 0;
        while index < remaining_accounts.len() {
            let mint_index = index / 4;

            let pd = PerformDeposit {
                config: config,
                locker: locker,
                mint: &remaining_accounts[index],
                owner: owner,
                admin: admin,
                user_ta: &remaining_accounts[index + 1],
                vault_ta: &remaining_accounts[index + 2],
                burn_ta: &remaining_accounts[index + 3],
                system_program: system_program,
                token_program: token_program,
                rent: rent,
            };
            perform_deposit(
                pd,
                vault_bumps[mint_index],
                deposit_amounts[mint_index],
                before_amounts[mint_index],
                burn_bumps[mint_index],
                should_go_in_burn_ta,
            )?;

            index += 4;
        }
        Ok(())
    }

    pub fn withdraw_v2<'a, 'b, 'c, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, WithdrawV2>,
        vault_bump: u8,
        burn_bump: u8,
        withdraw_amount: u64,
        before_amount: u64,
        final_amount: u64,
    ) -> Result<()> {
        let pd = PerformWithdraw {
            config: &mut ctx.accounts.config,
            locker: &mut ctx.accounts.locker,
            mint: &ctx.accounts.mint.to_account_info(),
            admin: &mut ctx.accounts.admin,
            user_ta_owner: &ctx.accounts.user_ta_owner,
            user_ta: &ctx.accounts.user_ta.to_account_info(),
            vault_ta: &ctx.accounts.vault_ta.to_account_info(),
            vault_ta_owner: &ctx.accounts.vault_ta_owner,
            burn_ta: &ctx.accounts.burn_ta.to_account_info(),
            system_program: &ctx.accounts.system_program,
            token_program: &ctx.accounts.token_program,
            associated_token_program: &ctx.accounts.associated_token_program,
            rent: &ctx.accounts.rent,
        };
        perform_withdraw(
            pd,
            withdraw_amount,
            before_amount,
            final_amount,
            vault_bump,
            burn_bump,
        )
    }

    pub fn withdraw_v2_batch<'a, 'b, 'c, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, WithdrawV2Batch<'info>>,
        withdraw_amounts: Vec<u64>,
        before_amounts: Vec<u64>,
        final_amounts: Vec<u64>,
        vault_bumps: Vec<u8>,
        burn_bumps: Vec<u8>,
    ) -> Result<()> {
        if ctx.remaining_accounts.len() % 5 != 0 {
            return Err(error!(ErrorCode::WrongRemainingAccountsSize));
        }

        let accounts: &'b mut WithdrawV2Batch<'info> = ctx.accounts;
        let config: &'b mut Account<'info, Config> = &mut accounts.config;
        let locker: &'b mut Account<'info, Locker> = &mut accounts.locker;
        let admin: &'b Signer<'info> = &accounts.admin;
        let user_ta_owner: &'b Signer<'info> = &accounts.user_ta_owner;
        let system_program: &'b Program<'info, System> = &accounts.system_program;
        let token_program: &'b Program<'info, Token> = &accounts.token_program;
        let associated_token_program: &'b Program<'info, AssociatedToken> =
            &accounts.associated_token_program;
        let rent: &'b Sysvar<'info, Rent> = &accounts.rent;
        let remaining_accounts: &'c [AccountInfo<'info>] = ctx.remaining_accounts;
        let mut index = 0;
        while index < remaining_accounts.len() {
            let mint_index = index / 5;

            let pd = PerformWithdraw {
                config: config,
                locker: locker,
                mint: &remaining_accounts[index],
                admin: admin,
                user_ta_owner: user_ta_owner,
                user_ta: &remaining_accounts[index + 1],
                vault_ta: &remaining_accounts[index + 2],
                vault_ta_owner: &remaining_accounts[index + 3],
                burn_ta: &remaining_accounts[index + 4],
                system_program: system_program,
                token_program: token_program,
                associated_token_program: associated_token_program,
                rent: rent,
            };
            perform_withdraw(
                pd,
                withdraw_amounts[mint_index],
                before_amounts[mint_index],
                final_amounts[mint_index],
                vault_bumps[mint_index],
                burn_bumps[mint_index],
            )?;

            index += 5;
        }
        Ok(())
    }
}
