pub mod state;
pub mod utils;

use crate::state::{ErrorCode, *};
use crate::utils::*;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{pubkey::Pubkey, rent::Rent};
use anchor_spl;

// declare_id!("CAsieqooSrgVxhgWRwh21gyjq7Rmuhmo4qTW9XzXtAvW");
declare_id!("FLoc9nBwGb2ayzVzb5GC9NttuPY3CxMhd4KDnApr79Ab");

#[program]
pub mod casier {
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
        let locker = &mut ctx.accounts.locker;
        let mk = ctx.accounts.mint.key();
        match locker.mints.iter().position(|&lm| lm == mk) {
            None => {
                if before_amount > 0 {
                    return Err(error!(ErrorCode::InvalidBeforeState));
                }
                locker.mints.push(mk);
                locker.amounts.push(deposit_amount);
            }
            Some(i) => {
                if before_amount != locker.amounts[i] {
                    return Err(error!(ErrorCode::InvalidBeforeState2));
                }
                locker.amounts[i] += deposit_amount;
            }
        }
        if should_go_in_burn_ta {
            if *(ctx.accounts.burn_ta.to_account_info().owner) != ctx.accounts.token_program.key() {
                let vault_account_seeds = &[
                    ctx.accounts.mint.to_account_info().key.as_ref(),
                    &[burn_bump],
                ];
                let vault_account_signer = &vault_account_seeds[..];
                // initialize nft vault account
                spl_init_token_account(InitializeTokenAccountParams {
                    account: ctx.accounts.burn_ta.to_account_info(),
                    account_signer_seeds: vault_account_signer,
                    mint: ctx.accounts.mint.to_account_info(),
                    owner: ctx.accounts.burn_ta.to_account_info(),
                    payer: ctx.accounts.owner.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    token_program: ctx.accounts.token_program.to_account_info(),
                    rent: ctx.accounts.rent.to_account_info(),
                })?;
            }
        } else {
            if *(ctx.accounts.vault_ta.to_account_info().owner) != ctx.accounts.token_program.key()
            {
                let vault_account_seeds = &[
                    ctx.accounts.mint.to_account_info().key.as_ref(),
                    ctx.accounts.owner.key.as_ref(),
                    &[vault_bump],
                ];
                let vault_account_signer = &vault_account_seeds[..];

                // initialize nft vault account
                spl_init_token_account(InitializeTokenAccountParams {
                    account: ctx.accounts.vault_ta.to_account_info(),
                    account_signer_seeds: vault_account_signer,
                    mint: ctx.accounts.mint.to_account_info(),
                    owner: ctx.accounts.vault_ta.to_account_info(),
                    payer: ctx.accounts.owner.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    token_program: ctx.accounts.token_program.to_account_info(),
                    rent: ctx.accounts.rent.to_account_info(),
                })?;
            }
        }

        let mut dest_ta = match should_go_in_burn_ta {
            true => Account::<'_, anchor_spl::token::TokenAccount>::try_from(
                &ctx.accounts.burn_ta.to_account_info(),
            )?,
            false => Account::<'_, anchor_spl::token::TokenAccount>::try_from(
                &ctx.accounts.vault_ta.to_account_info(),
            )?,
        };
        let is_valid_dest =
            dest_ta.owner == dest_ta.key() && dest_ta.mint == ctx.accounts.mint.key();

        if !is_valid_dest {
            return Err(error!(ErrorCode::InvalidVault));
        }

        spl_token_transfer(TokenTransferParams {
            source: ctx.accounts.user_ta.to_account_info(),
            destination: dest_ta.to_account_info(),
            amount: deposit_amount.into(),
            authority: ctx.accounts.owner.to_account_info(),
            authority_signer_seeds: &[],
            token_program: ctx.accounts.token_program.to_account_info(),
        })?;

        let vault_lamports = **ctx.accounts.vault_ta.try_borrow_mut_lamports()?;
        if should_go_in_burn_ta && vault_lamports > 0 {
            let vault_ta = Account::<'_, anchor_spl::token::TokenAccount>::try_from(
                &ctx.accounts.vault_ta.to_account_info(),
            )?;
            if vault_ta.amount > 0 {
                anchor_spl::token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        anchor_spl::token::Transfer {
                            from: ctx.accounts.vault_ta.to_account_info(),
                            to: dest_ta.to_account_info(),
                            authority: ctx.accounts.vault_ta.to_account_info(),
                        },
                        &[&[
                            ctx.accounts.mint.key().as_ref(),
                            ctx.accounts.locker.owner.key().as_ref(),
                            &[vault_bump],
                        ]],
                    ),
                    vault_ta.amount.into(),
                )?;
                anchor_spl::token::close_account(CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    anchor_spl::token::CloseAccount {
                        account: ctx.accounts.vault_ta.to_account_info(),
                        destination: ctx.accounts.owner.to_account_info(),
                        authority: ctx.accounts.vault_ta.to_account_info(),
                    },
                    &[&[
                        ctx.accounts.mint.key().as_ref(),
                        ctx.accounts.locker.owner.key().as_ref(),
                        &[vault_bump],
                    ]],
                ))?;
            }
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
        let locker = &mut ctx.accounts.locker;
        let mk = ctx.accounts.mint.key();

        let withdraw_from_burner_ta = ctx.accounts.vault_ta.key() == ctx.accounts.burn_ta.key();

        let mut sourceTa = match withdraw_from_burner_ta {
            true => Account::<'_, anchor_spl::token::TokenAccount>::try_from(
                &ctx.accounts.burn_ta.to_account_info(),
            )?,
            false => Account::<'_, anchor_spl::token::TokenAccount>::try_from(
                &ctx.accounts.vault_ta.to_account_info(),
            )?,
        };
        if sourceTa.amount < withdraw_amount {
            return Err(error!(ErrorCode::InsufficientFunds));
        }

        match locker.mints.iter().position(|&lm| lm == mk) {
            Some(mint_position) => {
                if locker.amounts[mint_position] != before_amount {
                    return Err(error!(ErrorCode::InvalidBeforeState));
                } else if final_amount > 0 {
                    locker.amounts[mint_position] = final_amount;
                } else {
                    locker.mints.remove(mint_position);
                    locker.amounts.remove(mint_position);
                }
            }
            None => {
                if before_amount != 0 {
                    return Err(error!(ErrorCode::InvalidBeforeState2));
                } else if !withdraw_from_burner_ta {
                    return Err(error!(ErrorCode::WithdrawForMintNotInLocker));
                } else if final_amount > 0 {
                    locker.mints.push(mk);
                    locker.amounts.push(final_amount);
                }
            }
        }

        let withdraw_type = get_withdraw_type(
            locker,
            ctx.accounts.user_ta_owner.key(),
            final_amount,
            sourceTa.amount,
            withdraw_amount,
        );

        if *ctx.accounts.user_ta.to_account_info().owner != ctx.accounts.token_program.key() {
            let cpi_program = ctx.accounts.associated_token_program.to_account_info();
            let cpi_accounts = anchor_spl::associated_token::Create {
                payer: ctx.accounts.user_ta_owner.to_account_info(),
                associated_token: ctx.accounts.user_ta.to_account_info(),
                authority: ctx.accounts.user_ta_owner.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
                rent: ctx.accounts.rent.to_account_info(),
            };
            let cpi_ctx = anchor_lang::context::CpiContext::new(cpi_program, cpi_accounts);
            anchor_spl::associated_token::create(cpi_ctx)?;
        }

        if withdraw_from_burner_ta {
            anchor_spl::token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    anchor_spl::token::Transfer {
                        from: ctx.accounts.burn_ta.to_account_info(),
                        to: ctx.accounts.user_ta.to_account_info(),
                        authority: ctx.accounts.burn_ta.to_account_info(),
                    },
                    &[&[ctx.accounts.mint.key().as_ref(), &[burn_bump]]],
                ),
                withdraw_amount.into(),
            )?;
        } else {
            anchor_spl::token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    anchor_spl::token::Transfer {
                        from: ctx.accounts.vault_ta.to_account_info(),
                        to: ctx.accounts.user_ta.to_account_info(),
                        authority: ctx.accounts.vault_ta.to_account_info(),
                    },
                    &[&[
                        ctx.accounts.mint.key().as_ref(),
                        ctx.accounts.locker.owner.key().as_ref(),
                        &[vault_bump],
                    ]],
                ),
                withdraw_amount.into(),
            )?;
        }

        // check if withdraw_type is WithdrawType::OwnerBurn or WithdrawType::NonOwnerBurn
        if matches!(
            withdraw_type,
            WithdrawType::OwnerBurn | WithdrawType::NonOwnerBurn
        ) && ctx.accounts.vault_ta.key() != ctx.accounts.burn_ta.key()
        {
            if *(ctx.accounts.burn_ta.to_account_info().owner) != ctx.accounts.token_program.key() {
                let mc = &ctx.accounts.mint.clone();
                let pk = &mc.key().clone();
                let pkr = pk.as_ref();

                let vault_account_seeds = &[pkr, &[burn_bump]];
                let vault_account_signer = &vault_account_seeds[..];

                // initialize nft vault account
                spl_init_token_account(InitializeTokenAccountParams {
                    account: ctx.accounts.burn_ta.to_account_info(),
                    account_signer_seeds: vault_account_signer,
                    mint: ctx.accounts.mint.to_account_info(),
                    owner: ctx.accounts.burn_ta.to_account_info(),
                    payer: ctx.accounts.user_ta_owner.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    token_program: ctx.accounts.token_program.to_account_info(),
                    rent: ctx.accounts.rent.to_account_info(),
                })?;
            }
            anchor_spl::token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    anchor_spl::token::Transfer {
                        from: ctx.accounts.vault_ta.to_account_info(),
                        to: ctx.accounts.burn_ta.to_account_info(),
                        authority: ctx.accounts.vault_ta.to_account_info(),
                    },
                    &[&[
                        ctx.accounts.mint.key().as_ref(),
                        ctx.accounts.locker.owner.key().as_ref(),
                        &[vault_bump],
                    ]],
                ),
                sourceTa.amount - final_amount,
            )?;
        }

        sourceTa.reload()?;
        if sourceTa.amount == 0 && !withdraw_from_burner_ta {
            anchor_spl::token::close_account(CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token::CloseAccount {
                    account: ctx.accounts.vault_ta.to_account_info(),
                    destination: ctx.accounts.vault_ta_owner.to_account_info(),
                    authority: ctx.accounts.vault_ta.to_account_info(),
                },
                &[&[
                    ctx.accounts.mint.key().as_ref(),
                    ctx.accounts.vault_ta_owner.key().as_ref(),
                    &[vault_bump],
                ]],
            ))?;
        }

        Ok(())
    }
}
