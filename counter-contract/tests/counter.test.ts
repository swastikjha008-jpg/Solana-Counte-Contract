import { FailedTransactionMetadata, LiteSVM } from "litesvm";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import path from "path";
import { beforeEach, describe, expect, test } from "bun:test";

// Produced by `cargo build-sbf`
const PROGRAM_SO = path.join(process.cwd(), "target/deploy/counter_program.so");
const COUNTER_SIZE = 4; // u32, little-endian (borsh)

function u32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}

describe("counter program", () => {
  let svm: LiteSVM;
  let programId: PublicKey;
  let payer: Keypair;

  beforeEach(() => {
    svm = new LiteSVM();
    programId = PublicKey.unique();
    svm.addProgramFromFile(programId, PROGRAM_SO);

    payer = new Keypair();
    svm.airdrop(payer.publicKey, BigInt(10 * LAMPORTS_PER_SOL));
  });

  function send(ixs: TransactionInstruction[], signers: Keypair[]) {
    const tx = new Transaction();
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = payer.publicKey;
    tx.add(...ixs);
    tx.sign(...signers);
    const res = svm.sendTransaction(tx);
    // a fresh blockhash lets us send identical transactions back to back
    svm.expireBlockhash();
    return res;
  }

  function createCounter(owner: PublicKey = programId): Keypair {
    const dataAccount = new Keypair();
    const lamports = Number(svm.minimumBalanceForRentExemption(BigInt(COUNTER_SIZE)));
    const ix = SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: dataAccount.publicKey,
      lamports,
      space: COUNTER_SIZE,
      programId: owner,
    });
    const res = send([ix], [payer, dataAccount]);
    expect(res).not.toBeInstanceOf(FailedTransactionMetadata);
    return dataAccount;
  }

  function doubleIx(dataAccount: PublicKey, isSigner = true): TransactionInstruction {
    return new TransactionInstruction({
      programId,
      keys: [{ pubkey: dataAccount, isSigner, isWritable: true }],
      data: Buffer.alloc(0),
    });
  }

  function readCount(dataAccount: PublicKey): number {
    const acc = svm.getAccount(dataAccount);
    expect(acc).not.toBeNull();
    return Buffer.from(acc!.data).readUInt32LE(0);
  }

  test("a fresh counter starts at 0", () => {
    const counter = createCounter();
    expect(readCount(counter.publicKey)).toBe(0);
  });

  test("first call sets the counter to 1", () => {
    const counter = createCounter();
    const res = send([doubleIx(counter.publicKey)], [payer, counter]);
    expect(res).not.toBeInstanceOf(FailedTransactionMetadata);
    expect(readCount(counter.publicKey)).toBe(1);
  });

  test("every later call doubles the counter", () => {
    const counter = createCounter();
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = send([doubleIx(counter.publicKey)], [payer, counter]);
      expect(res).not.toBeInstanceOf(FailedTransactionMetadata);
      seen.push(readCount(counter.publicKey));
    }
    expect(seen).toEqual([1, 2, 4, 8, 16, 32]);
  });

  test("two instructions in one transaction apply in order", () => {
    const counter = createCounter();
    const res = send(
      [doubleIx(counter.publicKey), doubleIx(counter.publicKey), doubleIx(counter.publicKey)],
      [payer, counter],
    );
    expect(res).not.toBeInstanceOf(FailedTransactionMetadata);
    expect(readCount(counter.publicKey)).toBe(4); // 0 -> 1 -> 2 -> 4
  });

  test("fails when the data account does not sign", () => {
    const counter = createCounter();
    const res = send([doubleIx(counter.publicKey, false)], [payer]);
    expect(res).toBeInstanceOf(FailedTransactionMetadata);
    expect(readCount(counter.publicKey)).toBe(0);
  });

  test("fails when the data account is not owned by the program", () => {
    const counter = createCounter(SystemProgram.programId);
    const res = send([doubleIx(counter.publicKey)], [payer, counter]);
    expect(res).toBeInstanceOf(FailedTransactionMetadata);
  });

  test("fails on overflow and leaves the counter unchanged", () => {
    const counter = createCounter();
    const acc = svm.getAccount(counter.publicKey)!;
    svm.setAccount(counter.publicKey, { ...acc, data: u32le(2 ** 31) });

    const res = send([doubleIx(counter.publicKey)], [payer, counter]);
    expect(res).toBeInstanceOf(FailedTransactionMetadata);
    expect(readCount(counter.publicKey)).toBe(2 ** 31);
  });

  test("counters are independent", () => {
    const a = createCounter();
    const b = createCounter();
    send([doubleIx(a.publicKey)], [payer, a]);
    send([doubleIx(a.publicKey)], [payer, a]);
    send([doubleIx(a.publicKey)], [payer, a]);
    send([doubleIx(b.publicKey)], [payer, b]);
    expect(readCount(a.publicKey)).toBe(4);
    expect(readCount(b.publicKey)).toBe(1);
  });
});
