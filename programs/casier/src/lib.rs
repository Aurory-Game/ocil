pub mod state;
pub mod utils;

use crate::state::{ErrorCode, *};
use crate::utils::*;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{pubkey::Pubkey, rent::Rent};
use anchor_spl;
use anchor_spl::{associated_token::AssociatedToken, token::Token};
// declare_id!("CAsieqooSrgVxhgWRwh21gyjq7Rmuhmo4qTW9XzXtAvW");
declare_id!("FLoc9nBwGb2ayzVzb5GC9NttuPY3CxMhd4KDnApr79Ab");

#[program]
pub mod casier {

    use super::*;

    pub fn init_config(ctx: Context<InitConfig>) -> Result<()> {
        ctx.accounts.config.admin = ctx.accounts.fee_payer.key();
        ctx.accounts.config.is_frozen = false;
        Ok(())
    }

    pub fn init_locker_v2(ctx: Context<InitLockerV2>) -> Result<()> {
        ctx.accounts.locker.owner = ctx.accounts.owner.key();
        ctx.accounts.locker.space = 0 as u64;
        Ok(())
    }

    pub fn deposit_batch<'a, 'b, 'c, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, DepositBatch<'info>>,
        deposit_amounts: Vec<u64>,
        vault_bumps: Vec<u8>,
        burn_bumps: Vec<u8>,
        pnft_count: u8,
        nonce: u64,
    ) -> Result<()> {
        const PNFT_CHUNK_SIZE: u8 = 8;
        const NORMAL_CHUNK_SIZE: u8 = 4;
        let pnft_ra_length = pnft_count * PNFT_CHUNK_SIZE + (if pnft_count > 0 { 3 } else { 0 });
        if ((ctx.remaining_accounts.len() as u8) - pnft_ra_length) % NORMAL_CHUNK_SIZE != 0 {
            return Err(error!(ErrorCode::WrongRemainingAccountsSize));
        }
        let accounts: &'b mut DepositBatch<'info> = ctx.accounts;
        let config: &'b mut Account<'info, Config> = &mut accounts.config;
        let locker: &'b mut Account<'info, Locker> = &mut accounts.locker;

        if locker.space != nonce {
            return Err(error!(ErrorCode::InvalidBeforeState));
        }
        locker.space += 1;

        let owner: &'b Signer<'info> = &accounts.owner;
        let admin: &'b Signer<'info> = &accounts.admin;
        let system_program: &'b Program<'info, System> = &accounts.system_program;
        let token_program: &'b Program<'info, Token> = &accounts.token_program;
        let rent: &'b Sysvar<'info, Rent> = &accounts.rent;
        let remaining_accounts: &'c [AccountInfo<'info>] = ctx.remaining_accounts;
        let token_metadata_program = &remaining_accounts[0];
        let spl_ata_program_info = &remaining_accounts[1];
        let instructions = &remaining_accounts[2];
        let mut index = if pnft_count > 0 { 3 } else { 0 };
        let mut mint_index: usize = 0;
        while index < remaining_accounts.len() {
            let mut pd = PerformDepositV2 {
                config: config,
                locker: locker,
                mint: &remaining_accounts[index],
                owner: owner,
                admin: admin,
                user_ta: &remaining_accounts[index + 1],
                vault_ta: &remaining_accounts[index + 2],
                burn_ta: &remaining_accounts[index + 3],
                metadata: None,
                token_record: None,
                destination_token_record: None,
                edition: None,
                token_metadata_program: token_metadata_program,
                instructions: instructions,
                spl_ata_program_info: spl_ata_program_info,
                system_program: system_program,
                token_program: token_program,
                rent: rent,
            };
            if (index as u8) < pnft_ra_length {
                pd.metadata = Some(&remaining_accounts[index + 4]);
                pd.token_record = Some(&remaining_accounts[index + 5]);
                pd.destination_token_record = Some(&remaining_accounts[index + 6]);
                pd.edition = Some(&remaining_accounts[index + 7]);
            }
            perform_deposit_v2(
                pd,
                vault_bumps[mint_index],
                deposit_amounts[mint_index],
                burn_bumps[mint_index],
            )?;
            index += if pnft_ra_length == 0 || (index as u8) > pnft_ra_length {
                NORMAL_CHUNK_SIZE as usize
            } else {
                PNFT_CHUNK_SIZE as usize
            };
            mint_index += 1;
        }
        Ok(())
    }

    pub fn withdraw_v2_batch<'a, 'b, 'c, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, WithdrawV2Batch<'info>>,
        withdraw_amounts: Vec<u64>,
        vault_bumps: Vec<u8>,
        burn_bumps: Vec<u8>,
        pnft_count: u8,
        nonce: u64,
    ) -> Result<()> {
        const PNFT_CHUNK_SIZE: u8 = 9;
        const NORMAL_CHUNK_SIZE: u8 = 5;
        let pnft_ra_length = pnft_count * PNFT_CHUNK_SIZE + (if pnft_count > 0 { 2 } else { 0 });
        if ((ctx.remaining_accounts.len() as u8) - pnft_ra_length) % NORMAL_CHUNK_SIZE != 0 {
            return Err(error!(ErrorCode::WrongRemainingAccountsSize));
        }
        let accounts: &'b mut WithdrawV2Batch<'info> = ctx.accounts;
        let config: &'b mut Account<'info, Config> = &mut accounts.config;
        let locker: &'b mut Account<'info, Locker> = &mut accounts.locker;

        if locker.space != nonce {
            return Err(error!(ErrorCode::InvalidBeforeState));
        }

        locker.space += 1;
        let admin: &'b Signer<'info> = &accounts.admin;
        let user_ta_owner: &'b Signer<'info> = &accounts.user_ta_owner;
        let system_program: &'b Program<'info, System> = &accounts.system_program;
        let token_program: &'b Program<'info, Token> = &accounts.token_program;
        let associated_token_program: &'b Program<'info, AssociatedToken> =
            &accounts.associated_token_program;
        let rent: &'b Sysvar<'info, Rent> = &accounts.rent;
        let remaining_accounts: &'c [AccountInfo<'info>] = ctx.remaining_accounts;
        let token_metadata_program = &remaining_accounts[0];
        let instructions = &remaining_accounts[1];
        let mut index = if pnft_count > 0 { 2 } else { 0 };
        let mut mint_index = 0;
        while index < remaining_accounts.len() {
            let mut pd = PerformWithdrawV2 {
                config: config,
                locker: locker,
                mint: &remaining_accounts[index],
                admin: admin,
                user_ta_owner: user_ta_owner,
                user_ta: &remaining_accounts[index + 1],
                vault_ta: &remaining_accounts[index + 2],
                vault_ta_owner: &remaining_accounts[index + 3],
                burn_ta: &remaining_accounts[index + 4],
                metadata: None,
                token_record: None,
                destination_token_record: None,
                edition: None,
                token_metadata_program: token_metadata_program,
                instructions: instructions,
                system_program: system_program,
                token_program: token_program,
                associated_token_program: associated_token_program,
                rent: rent,
            };
            if (index as u8) < pnft_ra_length {
                pd.metadata = Some(&remaining_accounts[index + 5]);
                pd.token_record = Some(&remaining_accounts[index + 6]);
                pd.destination_token_record = Some(&remaining_accounts[index + 7]);
                pd.edition = Some(&remaining_accounts[index + 8]);
            }
            perform_withdraw_v2(
                pd,
                withdraw_amounts[mint_index],
                vault_bumps[mint_index],
                burn_bumps[mint_index],
            )?;

            index += if pnft_ra_length == 0 || (index as u8) > pnft_ra_length {
                NORMAL_CHUNK_SIZE as usize
            } else {
                PNFT_CHUNK_SIZE as usize
            };
            mint_index += 1;
        }
        Ok(())
    }

    pub fn inc_nonce<'a, 'b, 'c, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, IncNonce<'info>>,
        nonce: u64,
    ) -> Result<()> {
        ctx.accounts.locker.space;
        if ctx.accounts.locker.space != nonce {
            return Err(error!(ErrorCode::InvalidBeforeState));
        }
        ctx.accounts.locker.space += 1;
        Ok(())
    }
}
