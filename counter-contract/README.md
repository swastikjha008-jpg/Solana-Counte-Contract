# Solana Counter Program

A minimal native Solana program. It owns a 4-byte data account holding a `u32` counter:

- first call: `0 -> 1`
- every later call: `count -> count * 2` (1, 2, 4, 8, 16, ...)

## Flow

1. Client creates a data account (`space = 4`, `owner = program id`) with `SystemProgram.createAccount`.
2. Client sends an instruction to the program with that account as `[signer, writable]`.
3. Program checks: account is a signer, account is owned by the program.
4. Program deserializes `CounterState` (borsh), sets/doubles the count, serializes it back.
5. Overflow (`count * 2 > u32::MAX`) returns `ArithmeticOverflow` and leaves state unchanged.

## Requirements

- Rust + Solana CLI tools (`cargo build-sbf`)
- Bun (https://bun.sh)

## Run

```bash
bun install

# 1. native Rust unit tests (no validator needed)
cargo test

# 2. build the .so, then run LiteSVM tests against it
cargo build-sbf
bun test

# or everything at once
bun run test:all
```

`cargo build-sbf` writes `target/deploy/counter_program.so`, which the LiteSVM tests load.

## Layout

```
src/lib.rs               program + Rust unit tests
tests/counter.test.ts    LiteSVM integration tests (bun:test)
Cargo.toml / Cargo.lock
package.json
```

## Deploy (devnet)

```bash
solana config set --url devnet
solana program deploy target/deploy/counter_program.so
```
