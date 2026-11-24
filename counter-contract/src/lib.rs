use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    msg,
    program_error::ProgramError,
    pubkey::Pubkey,
};

/// On-chain state stored in the data account (4 bytes, little-endian u32).
#[derive(BorshSerialize, BorshDeserialize, Debug, PartialEq)]
pub struct CounterState {
    pub count: u32,
}

/// Size in bytes of the data account this program expects.
pub const COUNTER_STATE_SIZE: usize = 4;

entrypoint!(process_instruction);

/// Accounts expected:
///   0. `[signer, writable]` data account, owned by this program, 4 bytes
///
/// Behaviour: count == 0 -> 1, otherwise count -> count * 2.
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    _instruction_data: &[u8],
) -> ProgramResult {
    let mut iter = accounts.iter();
    let data_account = next_account_info(&mut iter)?;

    if !data_account.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    if data_account.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }

    let mut counter_state = CounterState::try_from_slice(&data_account.data.borrow())?;

    if counter_state.count == 0 {
        counter_state.count = 1;
    } else {
        counter_state.count = counter_state
            .count
            .checked_mul(2)
            .ok_or(ProgramError::ArithmeticOverflow)?;
    }

    counter_state.serialize(&mut &mut data_account.data.borrow_mut()[..])?;

    msg!("counter is now {}", counter_state.count);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    /// Runs `process_instruction` once against a single data account and
    /// returns (result, resulting bytes).
    fn run(
        initial: &[u8],
        is_signer: bool,
        owner_is_program: bool,
    ) -> (ProgramResult, Vec<u8>) {
        let program_id = Pubkey::new_unique();
        let key = Pubkey::new_unique();
        let owner = if owner_is_program {
            program_id
        } else {
            Pubkey::new_unique()
        };
        let mut lamports = 1_000_000u64;
        let mut data = initial.to_vec();

        let account = AccountInfo {
            key: &key,
            is_signer,
            is_writable: true,
            lamports: Rc::new(RefCell::new(&mut lamports)),
            data: Rc::new(RefCell::new(&mut data[..])),
            owner: &owner,
            executable: false,
            rent_epoch: 0,
        };

        let res = process_instruction(&program_id, &[account], &[]);
        (res, data)
    }

    fn bytes(n: u32) -> Vec<u8> {
        n.to_le_bytes().to_vec()
    }

    #[test]
    fn first_call_sets_one() {
        let (res, data) = run(&bytes(0), true, true);
        assert!(res.is_ok());
        assert_eq!(data, bytes(1));
    }

    #[test]
    fn doubles_on_each_call() {
        let mut data = bytes(0);
        let mut seen = vec![];
        for _ in 0..6 {
            // the account buffer persists between calls on chain, so feed the
            // output of one run into the next
            let program_id = Pubkey::new_unique();
            let key = Pubkey::new_unique();
            let mut lamports = 1_000_000u64;
            let account = AccountInfo {
                key: &key,
                is_signer: true,
                is_writable: true,
                lamports: Rc::new(RefCell::new(&mut lamports)),
                data: Rc::new(RefCell::new(&mut data[..])),
                owner: &program_id,
                executable: false,
                rent_epoch: 0,
            };
            process_instruction(&program_id, &[account], &[]).unwrap();
            seen.push(u32::from_le_bytes(data[..4].try_into().unwrap()));
        }
        assert_eq!(seen, vec![1, 2, 4, 8, 16, 32]);
    }

    #[test]
    fn rejects_missing_signature() {
        let (res, data) = run(&bytes(4), false, true);
        assert_eq!(res, Err(ProgramError::MissingRequiredSignature));
        assert_eq!(data, bytes(4));
    }

    #[test]
    fn rejects_wrong_owner() {
        let (res, data) = run(&bytes(4), true, false);
        assert_eq!(res, Err(ProgramError::IncorrectProgramId));
        assert_eq!(data, bytes(4));
    }

    #[test]
    fn rejects_overflow_without_changing_state() {
        let (res, data) = run(&bytes(1 << 31), true, true);
        assert_eq!(res, Err(ProgramError::ArithmeticOverflow));
        assert_eq!(data, bytes(1 << 31));
    }

    #[test]
    fn rejects_wrong_data_size() {
        let (res, _) = run(&[0u8; 8], true, true);
        assert!(res.is_err());
    }

    #[test]
    fn rejects_no_accounts() {
        let program_id = Pubkey::new_unique();
        let res = process_instruction(&program_id, &[], &[]);
        assert_eq!(res, Err(ProgramError::NotEnoughAccountKeys));
    }
}
