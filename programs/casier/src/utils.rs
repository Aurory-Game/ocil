use crate::state::{ErrorCode, *};
use crate::state::{Locker, WithdrawType};
use anchor_lang::accounts::account_info;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    entrypoint::ProgramResult,
    program::{invoke, invoke_signed},
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
};
use anchor_spl;
use anchor_spl::token::TokenAccount;

pub fn create_pda_account<'a>(
    payer: &AccountInfo<'a>,
    space: usize,
    owner: &Pubkey,
    system_program: &AccountInfo<'a>,
    new_pda_account: &AccountInfo<'a>,
    new_pda_signer_seeds: &[&[u8]],
) -> ProgramResult {
    let rent = Rent::get()?;

    if new_pda_account.lamports() > 0 {
        let required_lamports = rent
            .minimum_balance(space)
            .max(1)
            .saturating_sub(new_pda_account.lamports());

        if required_lamports > 0 {
            invoke(
                &system_instruction::transfer(payer.key, new_pda_account.key, required_lamports),
                &[
                    payer.clone(),
                    new_pda_account.clone(),
                    system_program.clone(),
                ],
            )?;
        }

        invoke_signed(
            &system_instruction::allocate(new_pda_account.key, space as u64),
            &[new_pda_account.clone(), system_program.clone()],
            &[new_pda_signer_seeds],
        )?;

        invoke_signed(
            &system_instruction::assign(new_pda_account.key, owner),
            &[new_pda_account.clone(), system_program.clone()],
            &[new_pda_signer_seeds],
        )
    } else {
        invoke_signed(
            &system_instruction::create_account(
                payer.key,
                new_pda_account.key,
                rent.minimum_balance(space).max(1),
                space as u64,
                owner,
            ),
            &[
                payer.clone(),
                new_pda_account.clone(),
                system_program.clone(),
            ],
            &[new_pda_signer_seeds],
        )
    }
}

pub struct InitializeTokenAccountParams<'a: 'b, 'b> {
    /// CHECK: account
    pub account: AccountInfo<'a>,
    /// account_signer_seeds
    pub account_signer_seeds: &'b [&'b [u8]],
    /// CHECK: mint
    pub mint: AccountInfo<'a>,
    /// CHECK: owner
    pub owner: AccountInfo<'a>,
    /// CHECK: payer
    pub payer: AccountInfo<'a>,
    /// CHECK: system_program
    pub system_program: AccountInfo<'a>,
    /// CHECK: token_program
    pub token_program: AccountInfo<'a>,
    /// CHECK: rent
    pub rent: AccountInfo<'a>,
}

pub fn spl_init_token_account(params: InitializeTokenAccountParams<'_, '_>) -> Result<()> {
    let InitializeTokenAccountParams {
        account,
        account_signer_seeds,
        mint,
        owner,
        payer,
        system_program,
        token_program,
        rent,
    } = params;

    create_pda_account(
        &payer,
        anchor_spl::token::TokenAccount::LEN,
        token_program.key,
        &system_program,
        &account,
        account_signer_seeds,
    )?;

    let result = invoke(
        &anchor_spl::token::spl_token::instruction::initialize_account(
            token_program.key,
            account.key,
            mint.key,
            owner.key,
        )?,
        &[account, mint, owner, token_program, rent],
    );
    return result.map_err(|_| ErrorCode::TransferFail.into());
}

pub fn spl_init_token_account2(params: InitializeTokenAccountParams<'_, '_>) -> Result<()> {
    let InitializeTokenAccountParams {
        account,
        account_signer_seeds,
        mint,
        owner,
        payer,
        system_program,
        token_program,
        rent,
    } = params;

    let result = invoke(
        &anchor_spl::token::spl_token::instruction::initialize_account(
            token_program.key,
            account.key,
            mint.key,
            owner.key,
        )?,
        &[account, mint, owner, token_program, rent],
    );
    return result.map_err(|_| ErrorCode::TransferFail.into());
}

pub struct TokenTransferParams<'a: 'b, 'b> {
    /// CHECK: source
    pub source: AccountInfo<'a>,
    /// CHECK: destination
    pub destination: AccountInfo<'a>,
    /// amount
    pub amount: u64,
    /// CHECK: authority
    pub authority: AccountInfo<'a>,
    /// authority_signer_seeds
    pub authority_signer_seeds: &'b [&'b [u8]],
    /// CHECK: token_program
    pub token_program: AccountInfo<'a>,
}

pub fn spl_token_transfer(params: TokenTransferParams<'_, '_>) -> Result<()> {
    let TokenTransferParams {
        source,
        destination,
        authority,
        token_program,
        amount,
        authority_signer_seeds,
    } = params;

    let result = invoke(
        &anchor_spl::token::spl_token::instruction::transfer(
            token_program.key,
            source.key,
            destination.key,
            authority.key,
            &[],
            amount,
        )?,
        &[source, destination, authority, token_program],
    );

    return result.map_err(|_| ErrorCode::TransferFail.into());
}

pub fn get_withdraw_type(
    locker: &mut Account<Locker>,
    dest_owner: Pubkey,
    final_amount: u64,
    vault_ta_amount: u64,
    withdraw_amount: u64,
) -> WithdrawType {
    let needBurn = final_amount < vault_ta_amount - withdraw_amount;
    if (locker.owner == dest_owner) {
        if needBurn {
            return WithdrawType::OwnerBurn;
        }
        return WithdrawType::Owner;
    }

    if needBurn {
        return WithdrawType::NonOwnerBurn;
    }
    WithdrawType::NonOwner
}

fn get_token_account(ai: &AccountInfo) -> Result<TokenAccount> {
    TokenAccount::try_deserialize(&mut &ai.data.borrow()[..])
}

pub fn perform_deposit<'b, 'c, 'info>(
    mut pd: PerformDeposit<'b, 'c, 'info>,
    vault_bump: u8,
    deposit_amount: u64,
    before_amount: u64,
    burn_bump: u8,
    should_go_in_burn_ta: bool,
) -> Result<()> {
    let locker = &mut pd.locker;
    let mk = pd.mint.key();
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
        if *(pd.burn_ta.to_account_info().owner) != pd.token_program.key() {
            let vault_account_seeds = &[pd.mint.to_account_info().key.as_ref(), &[burn_bump]];
            let vault_account_signer = &vault_account_seeds[..];
            // initialize nft vault account
            spl_init_token_account(InitializeTokenAccountParams {
                account: pd.burn_ta.to_account_info(),
                account_signer_seeds: vault_account_signer,
                mint: pd.mint.to_account_info(),
                owner: pd.burn_ta.to_account_info(),
                payer: pd.owner.to_account_info(),
                system_program: pd.system_program.to_account_info(),
                token_program: pd.token_program.to_account_info(),
                rent: pd.rent.to_account_info(),
            })?;
        }
    } else {
        if *(pd.vault_ta.to_account_info().owner) != pd.token_program.key() {
            let vault_account_seeds = &[
                pd.mint.to_account_info().key.as_ref(),
                pd.owner.key.as_ref(),
                &[vault_bump],
            ];
            let vault_account_signer = &vault_account_seeds[..];

            // initialize nft vault account
            spl_init_token_account(InitializeTokenAccountParams {
                account: pd.vault_ta.to_account_info(),
                account_signer_seeds: vault_account_signer,
                mint: pd.mint.to_account_info(),
                owner: pd.vault_ta.to_account_info(),
                payer: pd.owner.to_account_info(),
                system_program: pd.system_program.to_account_info(),
                token_program: pd.token_program.to_account_info(),
                rent: pd.rent.to_account_info(),
            })?;
        }
    }

    let (mut dest_ta, dest_ai) = match should_go_in_burn_ta {
        true => (get_token_account(&pd.burn_ta)?, pd.burn_ta),
        false => (get_token_account(&pd.vault_ta)?, pd.vault_ta),
    };
    let is_valid_dest = dest_ta.owner == dest_ta.owner && dest_ta.mint == pd.mint.key();

    if !is_valid_dest {
        return Err(error!(ErrorCode::InvalidVault));
    }

    spl_token_transfer(TokenTransferParams {
        source: pd.user_ta.to_account_info(),
        destination: dest_ai.clone(),
        amount: deposit_amount.into(),
        authority: pd.owner.to_account_info(),
        authority_signer_seeds: &[],
        token_program: pd.token_program.to_account_info(),
    })?;

    let vault_lamports = **pd.vault_ta.try_borrow_mut_lamports()?;
    if should_go_in_burn_ta && vault_lamports > 0 {
        let vault_ta = get_token_account(pd.vault_ta)?;
        if vault_ta.amount > 0 {
            anchor_spl::token::transfer(
                CpiContext::new_with_signer(
                    pd.token_program.to_account_info(),
                    anchor_spl::token::Transfer {
                        from: pd.vault_ta.to_account_info(),
                        to: dest_ai.clone(),
                        authority: pd.vault_ta.to_account_info(),
                    },
                    &[&[
                        pd.mint.key().as_ref(),
                        pd.locker.owner.key().as_ref(),
                        &[vault_bump],
                    ]],
                ),
                vault_ta.amount.into(),
            )?;
            anchor_spl::token::close_account(CpiContext::new_with_signer(
                pd.token_program.to_account_info(),
                anchor_spl::token::CloseAccount {
                    account: pd.vault_ta.to_account_info(),
                    destination: pd.owner.to_account_info(),
                    authority: pd.vault_ta.to_account_info(),
                },
                &[&[
                    pd.mint.key().as_ref(),
                    pd.locker.owner.key().as_ref(),
                    &[vault_bump],
                ]],
            ))?;
        }
    }

    Ok(())
}

pub fn perform_withdraw<'b, 'c, 'info>(
    mut pd: PerformWithdraw<'b, 'c, 'info>,
    withdraw_amount: u64,
    before_amount: u64,
    final_amount: u64,
    vault_bump: u8,
    burn_bump: u8,
) -> Result<()> {
    let locker = &mut pd.locker;
    let mk = pd.mint.key();

    let withdraw_from_burner_ta = pd.vault_ta.key() == pd.burn_ta.key();

    let mut sourceTa = match withdraw_from_burner_ta {
        true => get_token_account(pd.burn_ta)?,
        false => get_token_account(pd.vault_ta)?,
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
        pd.user_ta_owner.key(),
        final_amount,
        sourceTa.amount,
        withdraw_amount,
    );

    if *pd.user_ta.to_account_info().owner != pd.token_program.key() {
        let cpi_program = pd.associated_token_program.to_account_info();
        let cpi_accounts = anchor_spl::associated_token::Create {
            payer: pd.user_ta_owner.to_account_info(),
            associated_token: pd.user_ta.to_account_info(),
            authority: pd.user_ta_owner.to_account_info(),
            mint: pd.mint.to_account_info(),
            system_program: pd.system_program.to_account_info(),
            token_program: pd.token_program.to_account_info(),
        };
        let cpi_ctx = anchor_lang::context::CpiContext::new(cpi_program, cpi_accounts);
        anchor_spl::associated_token::create(cpi_ctx)?;
    }

    if withdraw_from_burner_ta {
        anchor_spl::token::transfer(
            CpiContext::new_with_signer(
                pd.token_program.to_account_info(),
                anchor_spl::token::Transfer {
                    from: pd.burn_ta.to_account_info(),
                    to: pd.user_ta.to_account_info(),
                    authority: pd.burn_ta.to_account_info(),
                },
                &[&[pd.mint.key().as_ref(), &[burn_bump]]],
            ),
            withdraw_amount.into(),
        )?;
    } else {
        anchor_spl::token::transfer(
            CpiContext::new_with_signer(
                pd.token_program.to_account_info(),
                anchor_spl::token::Transfer {
                    from: pd.vault_ta.to_account_info(),
                    to: pd.user_ta.to_account_info(),
                    authority: pd.vault_ta.to_account_info(),
                },
                &[&[
                    pd.mint.key().as_ref(),
                    pd.locker.owner.key().as_ref(),
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
    ) && pd.vault_ta.key() != pd.burn_ta.key()
    {
        if *(pd.burn_ta.to_account_info().owner) != pd.token_program.key() {
            let mc = &pd.mint.clone();
            let pk = &mc.key().clone();
            let pkr = pk.as_ref();

            let vault_account_seeds = &[pkr, &[burn_bump]];
            let vault_account_signer = &vault_account_seeds[..];

            // initialize nft vault account
            spl_init_token_account(InitializeTokenAccountParams {
                account: pd.burn_ta.to_account_info(),
                account_signer_seeds: vault_account_signer,
                mint: pd.mint.to_account_info(),
                owner: pd.burn_ta.to_account_info(),
                payer: pd.user_ta_owner.to_account_info(),
                system_program: pd.system_program.to_account_info(),
                token_program: pd.token_program.to_account_info(),
                rent: pd.rent.to_account_info(),
            })?;
        }
        anchor_spl::token::transfer(
            CpiContext::new_with_signer(
                pd.token_program.to_account_info(),
                anchor_spl::token::Transfer {
                    from: pd.vault_ta.to_account_info(),
                    to: pd.burn_ta.to_account_info(),
                    authority: pd.vault_ta.to_account_info(),
                },
                &[&[
                    pd.mint.key().as_ref(),
                    pd.locker.owner.key().as_ref(),
                    &[vault_bump],
                ]],
            ),
            sourceTa.amount - final_amount,
        )?;
    }

    // sourceTa.reload()?;
    let mut sourceTa = match withdraw_from_burner_ta {
        true => get_token_account(pd.burn_ta)?,
        false => get_token_account(pd.vault_ta)?,
    };
    if sourceTa.amount == 0 && !withdraw_from_burner_ta {
        anchor_spl::token::close_account(CpiContext::new_with_signer(
            pd.token_program.to_account_info(),
            anchor_spl::token::CloseAccount {
                account: pd.vault_ta.to_account_info(),
                destination: pd.vault_ta_owner.to_account_info(),
                authority: pd.vault_ta.to_account_info(),
            },
            &[&[
                pd.mint.key().as_ref(),
                pd.vault_ta_owner.key().as_ref(),
                &[vault_bump],
            ]],
        ))?;
    }

    Ok(())
}
