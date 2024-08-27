use anchor_lang::prelude::*;
use anchor_spl::associated_token::{AssociatedToken};
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use std::mem::size_of;

declare_id!("");

const YEAR_DURATION: u128 = 3600 * 365 * 24;

#[program]
pub mod solana_token_staking {
    use super::*;

    pub fn create_state(
        _ctx: Context<CreateState>,
        token_per_second: u64,
    ) -> Result<()> {
        let state = &mut _ctx.accounts.state;

        require!(token_per_second > 0, ErrorCode::InvalidParams);

        state.authority = _ctx.accounts.authority.key();
        state.bump = _ctx.bumps.state;
        state.token_per_second = token_per_second;
        state.reward_mint = _ctx.accounts.reward_mint.key();
        state.id = 0;

        emit!(StateCreated {
            authority: _ctx.accounts.authority.key()
        });
        Ok(())
    }

    pub fn create_pool(
        _ctx: Context<CreateFarmPool>,
        point: u64,
        amount_multipler: u64,
        apy: u64,
        lock_time: u64,
        penalty: u64,
    ) -> Result<()> {
        let state = &mut _ctx.accounts.state;
        let pool = &mut _ctx.accounts.pool;

        require!(
            point > 0 &&
            amount_multipler > 0 &&
            apy > 0 &&
            lock_time > 0 &&
            penalty < 100,
            ErrorCode::InvalidParams
        );

        pool.bump = _ctx.bumps.pool;
        pool.mint = _ctx.accounts.mint.key();
        pool.vault = _ctx.accounts.vault.key();
        pool.reward_amount = 0;
        pool.point = point;
        pool.amount_multipler = amount_multipler;
        pool.authority = _ctx.accounts.authority.key();
        pool.apy = apy;
        pool.lock_time = lock_time;
        pool.id = state.id;
        pool.activated = 1;
        pool.penalty = penalty;
        
        state.total_point = state.total_point.checked_add(point).ok_or(ErrorCode::MathOverflow)?;
        state.id += 1;
        
        emit!(PoolCreated {
            mint: _ctx.accounts.mint.key(),
            id: pool.id,
        });
        Ok(())
    }

    pub fn update_pool(
        _ctx: Context<UpdateFarmPool>,
        flag: u8,
        penalty: u64,
        _id: u8
    ) -> Result<()> {
        let pool = &mut _ctx.accounts.pool;

        require!(penalty < 100, ErrorCode::InvalidParams);

        pool.activated = flag;
        pool.penalty = penalty;

        emit!(PoolUpdated {
            pool: _ctx.accounts.pool.key(),
            activated: flag,
            penalty: penalty
        });
        Ok(())
    }

    pub fn fund_reward_token(
        _ctx: Context<Fund>,
        amount: u64,
        _id: u8,
    ) -> Result<()> {
        let pool = &mut _ctx.accounts.pool;

        require!(amount > 0, ErrorCode::InvalidParams);

        pool.reward_amount = pool.reward_amount.checked_add(amount).ok_or(ErrorCode::MathOverflow)?;

        let cpi_accounts = Transfer {
            from: _ctx.accounts.user_vault.to_account_info(),
            to: _ctx.accounts.reward_vault.to_account_info(),
            authority: _ctx.accounts.authority.to_account_info(),
        };
        let cpi_program = _ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        emit!(RewardFunded {
            amount: amount
        });
        Ok(())
    }

    pub fn create_user(
        _ctx: Context<CreatePoolUser>,
        _id: u8,
    ) -> Result<()> {
        let user = &mut _ctx.accounts.user;
        user.authority = _ctx.accounts.authority.key();
        user.bump = _ctx.bumps.user;
        user.pool = _ctx.accounts.pool.key();

        let pool = &mut _ctx.accounts.pool;
        pool.total_user = pool.total_user.checked_add(1).ok_or(ErrorCode::MathOverflow)?;

        emit!(UserCreated {
            pool: _ctx.accounts.pool.key(),
            user: _ctx.accounts.user.key(),
            authority: _ctx.accounts.authority.key(),
        });
        Ok(())
    }

    pub fn stake(
        _ctx: Context<Stake>,
        amount: u64,
        _id: u8
    ) -> Result<()> {
        let user = &mut _ctx.accounts.user;
        let pool = &mut _ctx.accounts.pool;

        require!(
            pool.activated > 0 &&
            amount > 0,
            ErrorCode::PoolDeactivated
        );

        user.amount = user.amount.checked_add(amount).ok_or(ErrorCode::MathOverflow)?;
        pool.amount = pool.amount.checked_add(amount).ok_or(ErrorCode::MathOverflow)?;

        user.last_stake_time = u64::try_from(Clock::get()?.unix_timestamp).map_err(|_| ErrorCode::MathPanic)?;

        let cpi_accounts = Transfer {
            from: _ctx.accounts.user_vault.to_account_info(),
            to: _ctx.accounts.pool_vault.to_account_info(),
            authority: _ctx.accounts.authority.to_account_info(),
        };
        let cpi_program = _ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        emit!(UserStaked {
            pool: _ctx.accounts.pool.key(),
            user: _ctx.accounts.user.key(),
            authority: _ctx.accounts.authority.key(),
            amount
        });
        Ok(())
    }

    pub fn unstake(
        _ctx: Context<Stake>,
        amount: u64,
        id: u8
    ) -> Result<()> {
        let user = &mut _ctx.accounts.user;
        let pool = &mut _ctx.accounts.pool;

        require!(
            user.amount >= amount &&
            amount > 0,
            ErrorCode::UnstakeOverAmount
        );

        let cur_timestamp = u64::try_from(Clock::get()?.unix_timestamp).map_err(|_| ErrorCode::MathPanic)?;

        let mut unstake_amount: u64 = amount;
        if user.last_stake_time
            .checked_add(pool.lock_time)
            .ok_or(ErrorCode::MathOverflow)? > cur_timestamp {
            unstake_amount = amount
            .checked_mul(100 - pool.penalty)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(100)
            .ok_or(ErrorCode::MathUnderflow)?
        }

        let seconds = cur_timestamp
            .checked_sub(user.last_stake_time)
            .ok_or(ErrorCode::MathUnderflow)?;

        let total_reward_amount: u128 = u128::from(unstake_amount)
            .checked_mul(pool.apy as u128)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(100)
            .ok_or(ErrorCode::MathUnderflow)?
            .checked_mul(seconds as u128)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(YEAR_DURATION)
            .ok_or(ErrorCode::MathUnderflow)?;

        user.reward_amount = user.reward_amount.checked_add(total_reward_amount).ok_or(ErrorCode::MathOverflow)?;

        user.amount = user.amount.checked_sub(amount).ok_or(ErrorCode::MathUnderflow)?;
        pool.amount = pool.amount.checked_sub(unstake_amount).ok_or(ErrorCode::MathUnderflow)?;

        let new_pool = &_ctx.accounts.pool;
        let cpi_accounts = Transfer {
            from: _ctx.accounts.pool_vault.to_account_info(),
            to: _ctx.accounts.user_vault.to_account_info(),
            authority: _ctx.accounts.pool.to_account_info(),
        };

        let binding = [id];
        let seeds = &[new_pool.mint.as_ref(), binding.as_ref(), &[new_pool.bump]];
        let signer = &[&seeds[..]];
        let cpi_program = _ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
        token::transfer(cpi_ctx, unstake_amount)?;

        emit!(UserUnstaked {
            pool: _ctx.accounts.pool.key(),
            user: _ctx.accounts.user.key(),
            authority: _ctx.accounts.authority.key(),
            amount: unstake_amount
        });
        Ok(())
    }

    pub fn harvest(
        _ctx: Context<Harvest>,
        id: u8,
    ) -> Result<()> {
        let pool = &mut _ctx.accounts.pool;
        let user = &mut _ctx.accounts.user;
        let cur_timestamp = u64::try_from(Clock::get()?.unix_timestamp).map_err(|_| ErrorCode::MathPanic)?;

        let seconds = cur_timestamp
            .checked_sub(user.last_stake_time)
            .ok_or(ErrorCode::MathUnderflow)?;

        let until_new_reward_amount: u128 = u128::from(user.amount)
            .checked_mul(pool.amount_multipler as u128)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_mul(pool.apy as u128)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(100)
            .ok_or(ErrorCode::MathUnderflow)?
            .checked_mul(seconds as u128)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(YEAR_DURATION)
            .ok_or(ErrorCode::MathUnderflow)?;

        let total_reward = user
            .reward_amount
            .checked_add(until_new_reward_amount)
            .ok_or(ErrorCode::MathOverflow)?
            .try_into()
            .map_err(|_| ErrorCode::MathPanic)?;

        require!(pool.reward_amount >= total_reward, ErrorCode::HarvestOverAmount);

        let cpi_accounts = Transfer {
            from: _ctx.accounts.reward_vault.to_account_info(),
            to: _ctx.accounts.user_vault.to_account_info(),
            authority: pool.to_account_info(),
        };

        let binding = [id];
        let seeds = &[pool.mint.as_ref(), binding.as_ref(), &[pool.bump]];
        let signer = &[&seeds[..]];
        let cpi_program = _ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
        token::transfer(cpi_ctx, total_reward)?;

        pool.reward_amount = pool.reward_amount.checked_sub(total_reward).ok_or(ErrorCode::MathUnderflow)?;
        user.reward_amount = 0;

        emit!(UserHarvested {
            pool: _ctx.accounts.pool.key(),
            user: _ctx.accounts.user.key(),
            authority: _ctx.accounts.authority.key(),
            amount: total_reward
        });
        Ok(())
    }

    pub fn withdraw(
        _ctx: Context<Fund>,
        amount: u64,
        id: u8
    ) -> Result<()> {
        let pool = &_ctx.accounts.pool;
    
        let binding = [id];
        let seeds = &[pool.mint.as_ref(), binding.as_ref(), &[pool.bump]];
        let signer = &[&seeds[..]];
    
        let cpi_accounts = Transfer {
            from: _ctx.accounts.reward_vault.to_account_info(),
            to: _ctx.accounts.user_vault.to_account_info(),
            authority: pool.to_account_info(),
        };
    
        let cpi_program = _ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
        token::transfer(cpi_ctx, amount)?;
        
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(
    token_per_second: u64,
)]
pub struct CreateState<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        seeds = [b"state".as_ref(), authority.key().as_ref()],
        bump,
        space = 8 + size_of::<StateAccount>(),
        payer = authority
    )]
    pub state: Account<'info, StateAccount>,

    pub reward_mint: Box<Account<'info, Mint>>,
    
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(
    point: u64,
    amount_multipler: u64,
    apy: u64,
    lock_time: u64,
    penalty: u64,
)]
pub struct CreateFarmPool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"state".as_ref(), authority.key().as_ref()],
        bump,
        has_one = authority,
    )]
    pub state: Box<Account<'info, StateAccount>>,

    #[account(
        init,
        seeds = [mint.key().as_ref(), &state.id.to_le_bytes()],
        bump,
        space = 8 + size_of::<FarmPoolAccount>(),
        payer = authority,
    )]
    pub pool: Box<Account<'info, FarmPoolAccount>>,
    
    pub mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        associated_token::mint = mint,
        associated_token::authority = pool,
        payer = authority,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(
    flag: u8,
    penalty: u64,
    id: u8,
)]
pub struct UpdateFarmPool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"state".as_ref(), authority.key().as_ref()],
        bump,
    )]
    pub state: Account<'info, StateAccount>,

    #[account(
        mut,
        seeds = [pool.mint.key().as_ref(), &[id]],
        bump,
        constraint = state.authority == authority.key(),
    )]
    pub pool: Account<'info, FarmPoolAccount>,    
}

#[derive(Accounts)]
#[instruction(
    amount: u64,
    id: u8,
)]
pub struct Fund<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"state".as_ref(), authority.key().as_ref()],
        bump,
    )]
    pub state: Account<'info, StateAccount>,

    #[account(
        mut,
        seeds = [pool.mint.key().as_ref(), &[id]],
        bump,
        constraint = state.authority == authority.key(),
    )]
    pub pool: Account<'info, FarmPoolAccount>,   
    
    #[account(mut)]
    pub reward_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = user_vault.owner == authority.key(),
    )]
    pub user_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(
    id: u8,
)]
pub struct CreatePoolUser<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: this should be checked with address in state
    pub owner: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [b"state".as_ref(), owner.key().as_ref()],
        bump
    )]
    pub state: Account<'info, StateAccount>,

    #[account(
        mut,
        seeds = [pool.mint.key().as_ref(), &[id]],
        bump,
    )]
    pub pool: Account<'info, FarmPoolAccount>,

    #[account(
        init,
        seeds = [pool.key().as_ref(), authority.key().as_ref()],
        bump,        
        space = 8 + size_of::<FarmPoolUserAccount>(),
        payer = authority,
    )]
    pub user: Account<'info, FarmPoolUserAccount>,
    
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(
    amount: u64, 
    id: u8,
)]
pub struct Stake<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: this should be checked with address in state
    pub owner: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [b"state".as_ref(), owner.key().as_ref()],
        bump,
    )]
    pub state: Account<'info, StateAccount>,

    #[account(
        mut,
        seeds = [pool.mint.key().as_ref(), &[id]],
        bump,
    )]
    pub pool: Account<'info, FarmPoolAccount>,

    #[account(
        mut,
        seeds = [pool.key().as_ref(), authority.key().as_ref()],
        bump,
    )]
    pub user: Account<'info, FarmPoolUserAccount>,
    
    #[account(
        constraint = mint.key() == pool.mint,
    )]
    pub mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        constraint = pool_vault.owner == pool.key(),
    )]
    pub pool_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = user_vault.owner == authority.key(),
    )]
    pub user_vault: Box<Account<'info, TokenAccount>>,
    
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(
    id: u8,
)]
pub struct Harvest<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: this should be checked with address in state
    pub owner: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [pool.mint.key().as_ref(), &[id]],
        bump,
    )]
    pub pool: Account<'info, FarmPoolAccount>,

    #[account(
        mut,
        seeds = [pool.key().as_ref(), authority.key().as_ref()],
        bump,
    )]
    pub user: Account<'info, FarmPoolUserAccount>,
    
    #[account(
        constraint = mint.key() == pool.mint,
    )]
    pub mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        constraint = reward_vault.owner == pool.key(),
    )]
    pub reward_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = authority,
        associated_token::mint = mint,
        associated_token::authority = authority,
    )]
    pub user_vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(Default)]
pub struct StateAccount {
    pub authority: Pubkey,
    pub reward_mint: Pubkey,
    pub bump: u8,
    pub total_point: u64,
    pub token_per_second: u64,
    pub id: u8,
}

#[account]
#[derive(Default)]
pub struct FarmPoolAccount {
    pub bump: u8,
    pub authority: Pubkey,
    pub amount: u64,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub reward_amount: u64,
    pub point: u64,
    pub amount_multipler: u64,
    pub total_user: u64,
    pub apy: u64,
    pub lock_time: u64,
    pub id: u8,
    pub activated: u8,
    pub penalty: u64,
}

#[account]
#[derive(Default)]
pub struct FarmPoolUserAccount {
    pub bump: u8,
    pub pool: Pubkey,
    pub authority: Pubkey,
    pub amount: u64,
    pub reward_amount: u128,
    pub last_stake_time: u64,
    pub id: u8,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid params input")]
    InvalidParams,
    #[msg("Over staked amount")]
    UnstakeOverAmount,
    #[msg("Over harvest amount")]
    HarvestOverAmount,
    #[msg("Pool is deactivated")]
    PoolDeactivated,
    #[msg("Math overflow occurred")]
    MathOverflow,
    #[msg("Math underflow occurred")]
    MathUnderflow,
    #[msg("Math panic occurred")]
    MathPanic,
}

#[event]
pub struct StateCreated {
    authority: Pubkey
}

#[event]
pub struct PoolCreated {
    mint: Pubkey,
    id: u8,
}

#[event]
pub struct PoolUpdated {
    pool: Pubkey,
    activated: u8,
    penalty: u64,
}

#[event]
pub struct RewardFunded {
    amount: u64,
}

#[event]
pub struct UserCreated {
    pool: Pubkey,
    user: Pubkey,
    authority: Pubkey,
}

#[event]
pub struct UserStaked {
    pool: Pubkey,
    user: Pubkey,
    authority: Pubkey,
    amount: u64,
}

#[event]
pub struct UserUnstaked {
    pool: Pubkey,
    user: Pubkey,
    authority: Pubkey,
    amount: u64,
}

#[event]
pub struct UserHarvested {
    pool: Pubkey,
    user: Pubkey,
    authority: Pubkey,
    amount: u64,
}