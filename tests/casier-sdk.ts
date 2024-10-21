import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
//@ts-ignore
import { Casier } from "../target/types/casier";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Connection,
  ParsedTransactionWithMeta,
  ComputeBudgetProgram,
  Signer,
  AddressLookupTableProgram,
  AddressLookupTableAccount,
} from "@solana/web3.js";
import {
  createMint,
  mintTo,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createMintToInstruction,
} from "@solana/spl-token";
import { assert } from "chai";
import { TxSender, createMintInstruction } from "./utils";
import { LockerSDK } from "../package/index";

// Configure the client to use the local cluster.
anchor.setProvider(anchor.AnchorProvider.env());

const program = anchor.workspace.Casier as Program<Casier>;
const provider = program.provider as anchor.AnchorProvider;
const payer = (provider.wallet as anchor.Wallet).payer;
const signer = {
  publicKey: payer.publicKey,
  secretKey: payer.secretKey,
} as Signer;
const providerPk = (program.provider as anchor.AnchorProvider).wallet.publicKey;
const txSender = new TxSender(provider.connection);
const mints = [];
const users = [...Array(3).keys()].map(() => Keypair.generate());
const decimals = 9;
const mantissa = new anchor.BN(10 ** decimals);

let lockerPDAs;
let configPDA;
// 2D array: users index, token accounts by mint index
const tokenAccounts: PublicKey[][] = [];
// 2D array: users, token account bumps by mint index
const tokenAccountBumps: number[][] = [];
// 2D array: user index, token accounts by mint index
const vaultTAs: PublicKey[][] = [];
// 2D array: user index, token account bumps by mint index
const vaultTABumps: number[][] = [];
let lookupTable: AddressLookupTableAccount;

const lsdk = new LockerSDK(
  provider.connection,
  payer.publicKey,
  program.programId,
  payer.publicKey
);

const defaultSpace = 500;

describe("casier-lsdk", () => {
  it("Prepare", async () => {
    // compute config PDA
    [configPDA] = await PublicKey.findProgramAddress(
      [anchor.utils.bytes.utf8.encode("config")],
      program.programId
    );

    // airdrops sols
    await Promise.all(
      users.map((user) =>
        provider.connection.requestAirdrop(user.publicKey, 100 * 1e9)
      )
    );

    // create mints
    await Promise.all(
      [...Array(5).keys()]
        .map(() => Keypair.generate())
        .map((mint) => {
          mints.push(mint.publicKey);
          return createMint(
            provider.connection,
            payer,
            providerPk,
            providerPk,
            decimals,
            mint
          );
        })
    );

    // initialize user token accounts
    await Promise.all(
      users.map((user, index) => {
        tokenAccounts.push([]);
        tokenAccountBumps.push([]);
        return Promise.all(
          mints.map(async (mint) => {
            const [address, bump] = await PublicKey.findProgramAddress(
              [
                user.publicKey.toBuffer(),
                TOKEN_PROGRAM_ID.toBuffer(),
                mint.toBuffer(),
              ],
              ASSOCIATED_TOKEN_PROGRAM_ID
            );
            tokenAccounts[index].push(address);
            tokenAccountBumps[index].push(bump);
            return await createAssociatedTokenAccount(
              provider.connection,
              payer,
              mint,
              user.publicKey
            );
          })
        );
      })
    );

    const amountToMint = mantissa.mul(new anchor.BN(1e9));

    // mint tokens
    await Promise.all(
      mints.flatMap((mint, mintIndex) =>
        users
          .slice(0, 2)
          .map((user, userIndex) =>
            mintTo(
              provider.connection,
              payer,
              mint,
              tokenAccounts[userIndex][mintIndex],
              payer.publicKey,
              BigInt(amountToMint.toString())
            )
          )
      )
    );

    // init user lockers
    lockerPDAs = await Promise.all(
      users.map(async (u) => {
        const pa = await PublicKey.findProgramAddress(
          [u.publicKey.toBytes()],
          program.programId
        );
        return pa[0];
      })
    );

    // initialize vault token accounts
    await Promise.all(
      users.map((user, index) =>
        mints.map(async (mint) => {
          const [ta, bump] = await PublicKey.findProgramAddress(
            [mint.toBuffer(), user.publicKey.toBuffer()],
            program.programId
          );
          if (vaultTAs[index]) {
            vaultTAs[index].push(ta);
            vaultTABumps[index].push(bump);
          } else {
            vaultTAs[index] = [ta];
            vaultTABumps[index] = [bump];
          }
        })
      )
    );
    const slot = await provider.connection.getSlot("finalized");
    const [createLookupTableInst, lookupTableAddress] =
      AddressLookupTableProgram.createLookupTable({
        authority: payer.publicKey,
        payer: payer.publicKey,
        recentSlot: slot,
      });
    const extendTableInst = AddressLookupTableProgram.extendLookupTable({
      /** Address lookup table account to extend. */
      lookupTable: lookupTableAddress,
      /** Account which is the current authority. */
      authority: payer.publicKey,
      /** Account that will fund the table reallocation.
       * Not required if the reallocation has already been funded. */
      payer: payer.publicKey,
      /** List of Public Keys to be added to the lookup table. */
      addresses: [
        configPDA,
        providerPk,
        SystemProgram.programId,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
        SYSVAR_RENT_PUBKEY,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ],
    });

    await txSender.createAndSendV0Tx({
      txInstructions: [createLookupTableInst, extendTableInst],
      payer: payer.publicKey,
      signers: [payer],
    });
    lookupTable = (
      await provider.connection.getAddressLookupTable(lookupTableAddress)
    ).value;

    let existingConfig;
    try {
      existingConfig = await program.account.config.fetch(configPDA);
    } catch (e) {}
    if (!existingConfig) {
      console.log(">> Initialize Config");
      const tx = await program.methods
        .initConfig()
        .accounts({
          config: configPDA,
          feePayer: providerPk,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();
    }
  });

  it("Deposit to closed vault TA: u: 0, m: 0, a: 100", async () => {
    const userIndex = 0;
    const mintIndex = 0;
    const amount = 100;
    const deposit_amount = mantissa.muln(amount);

    const user = users[userIndex];
    const mint = mints[mintIndex];
    const userTa = tokenAccounts[userIndex][mintIndex];
    const vaultTa = vaultTAs[userIndex][mintIndex];
    const locker = lockerPDAs[userIndex];

    const [burnTa, burnBump] = await PublicKey.findProgramAddress(
      [mint.toBuffer()],
      program.programId
    );
    const ixs = await lsdk.depositInstruction([mint], user.publicKey, [
      deposit_amount,
    ]);
    await txSender.createAndSendV0Tx({
      txInstructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 2_000_000 }),
        ...ixs,
      ],
      payer: user.publicKey,
      signers: [user, payer],
      shouldLog: false,
    });
    const vaultAmount = await getAmountfromTa(vaultTa);
    const burnAmount = await getAmountfromTa(burnTa);
    const lockerAccount = await program.account.locker.fetch(locker);
    assert.strictEqual(vaultAmount, 0);
    assert.strictEqual(burnAmount, amount);
    assert.strictEqual(lockerAccount.space.toNumber(), 1);
  });

  it("Deposit to closed vault TA second mint: u: 0, m: 1, a: 100", async () => {
    const userIndex = 0;
    const mintIndex = 1;
    const amount = 100;
    const deposit_amount = mantissa.muln(amount);

    const user = users[userIndex];
    const mint = mints[mintIndex];
    const userTa = tokenAccounts[userIndex][mintIndex];
    const vaultTa = vaultTAs[userIndex][mintIndex];
    const locker = lockerPDAs[userIndex];
    const { space } = await program.account.locker.fetch(locker);

    const [burnTa, burnBump] = await PublicKey.findProgramAddress(
      [mint.toBuffer()],
      program.programId
    );
    const ixs = await lsdk.depositInstruction([mint], user.publicKey, [
      deposit_amount,
    ]);
    await txSender.createAndSendV0Tx({
      txInstructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 2_000_000 }),
        ...ixs,
      ],
      payer: user.publicKey,
      signers: [user, payer],
      shouldLog: false,
    });
    const vaultAmount = await getAmountfromTa(vaultTa);
    const burnAmount = await getAmountfromTa(burnTa);
    const lockerAccount = await program.account.locker.fetch(locker);
    assert.strictEqual(vaultAmount, 0);
    assert.strictEqual(burnAmount, amount);
    assert.strictEqual(
      lockerAccount.space.toString(),
      (space.toNumber() + 1).toString()
    );
  });

  it("Deposit to opened vault TA: u: 0, m: 0, a: 1e6", async () => {
    const userIndex = 0;
    const mintIndex = 0;
    const amount = 1e6;
    const deposit_amount = mantissa.muln(amount);

    const user = users[userIndex];
    const mint = mints[mintIndex];
    const userTa = tokenAccounts[userIndex][mintIndex];
    const vaultTa = vaultTAs[userIndex][mintIndex];
    const locker = lockerPDAs[userIndex];
    const { space } = await program.account.locker.fetch(locker);

    const [burnTa, burnBump] = await PublicKey.findProgramAddress(
      [mint.toBuffer()],
      program.programId
    );
    const burnAmountBefore = await getAmountfromTa(burnTa);

    const ixs = await lsdk.depositInstruction([mint], user.publicKey, [
      deposit_amount,
    ]);
    await txSender.createAndSendV0Tx({
      txInstructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 2_000_000 }),
        ...ixs,
      ],
      payer: user.publicKey,
      signers: [user, payer],
      shouldLog: false,
    });
    const vaultAmount = await getAmountfromTa(vaultTa);
    const burnAmount = await getAmountfromTa(burnTa);
    const lockerAccount = await program.account.locker.fetch(locker);
    assert.strictEqual(vaultAmount, 0);
    assert.strictEqual(burnAmount, burnAmountBefore + amount);
    assert.strictEqual(
      lockerAccount.space.toString(),
      (space.toNumber() + 1).toString()
    );
  });

  it("Withdraw from userTa: u: 0, m: 0, a: 1e5", async () => {
    const userIndex = 0;
    const mintIndex = 0;
    const amount = 1e5;
    const withdrawAmount = mantissa.muln(amount);

    const user = users[userIndex];
    const mint = mints[mintIndex];
    const userTa = tokenAccounts[userIndex][mintIndex];
    const vaultTa = vaultTAs[userIndex][mintIndex];
    const locker = lockerPDAs[userIndex];
    const { space } = await program.account.locker.fetch(locker);

    const [burnTa, burnBump] = await PublicKey.findProgramAddress(
      [mint.toBuffer()],
      program.programId
    );
    const burnAmountBefore = await getAmountfromTa(burnTa);

    const ixs = await lsdk.withdrawInstruction(
      [mint],
      user.publicKey,
      [user.publicKey],
      [withdrawAmount]
    );
    await txSender.createAndSendV0Tx({
      txInstructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 2_000_000 }),
        ...ixs,
      ],
      payer: user.publicKey,
      signers: [user, payer],
      shouldLog: false,
    });
    const vaultAmount = await getAmountfromTa(vaultTa);
    const burnAmount = await getAmountfromTa(burnTa);
    const lockerAccount = await program.account.locker.fetch(locker);
    assert.strictEqual(vaultAmount, 0);
    assert.strictEqual(burnAmount, burnAmountBefore - amount);
    assert.strictEqual(
      lockerAccount.space.toString(),
      (space.toNumber() + 1).toString()
    );
  });

  it("Withdraw to different userTa than depositor: u: 1, m: 0, a: 1e5", async () => {
    const userIndex = 1;
    const mintIndex = 0;
    const amount = 1e5;
    const withdrawAmount = mantissa.muln(amount);

    const user = users[userIndex];
    const mint = mints[mintIndex];
    const userTa = tokenAccounts[userIndex][mintIndex];
    const vaultTa = vaultTAs[userIndex][mintIndex];
    const locker = lockerPDAs[userIndex];
    const [burnTa, burnBump] = await PublicKey.findProgramAddress(
      [mint.toBuffer()],
      program.programId
    );
    const burnAmountBefore = await getAmountfromTa(burnTa);
    const ixs = await lsdk.withdrawInstruction(
      [mint],
      user.publicKey,
      [user.publicKey],
      [withdrawAmount]
    );
    await txSender.createAndSendV0Tx({
      txInstructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 2_000_000 }),
        ...ixs,
      ],
      payer: user.publicKey,
      signers: [user, payer],
      shouldLog: false,
    });
    const vaultAmount = await getAmountfromTa(vaultTa);
    const burnAmount = await getAmountfromTa(burnTa);
    const lockerAccount = await program.account.locker.fetch(locker);
    assert.strictEqual(vaultAmount, 0);
    assert.strictEqual(burnAmount, burnAmountBefore - amount);
    assert.strictEqual(lockerAccount.space.toNumber(), 1);
  });

  it("Withdraw to existing locker & non-existing mint: u: 1, m: x, a: 1e5", async () => {
    const userIndex = 1;
    const amount = 1e5;
    const withdrawAmount = mantissa.muln(amount);

    const user = users[userIndex];
    const mintKp = Keypair.generate();
    const mint = mintKp.publicKey;
    const [userTa] = PublicKey.findProgramAddressSync(
      [user.publicKey.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const [vaultTa, bump] = PublicKey.findProgramAddressSync(
      [mint.toBuffer(), user.publicKey.toBuffer()],
      program.programId
    );
    const [locker] = PublicKey.findProgramAddressSync(
      [user.publicKey.toBytes()],
      program.programId
    );
    const { space } = await program.account.locker.fetch(locker);

    const [burnTa, burnBump] = PublicKey.findProgramAddressSync(
      [mint.toBuffer()],
      program.programId
    );
    const burnAmountBefore = await getAmountfromTa(burnTa);

    const createMintIxs = await createMintInstruction(
      provider.connection,
      payer,
      providerPk,
      providerPk,
      decimals,
      mintKp
    );
    const mintToIx = createMintToInstruction(
      mint,
      userTa,
      payer.publicKey,
      withdrawAmount.toNumber()
    );
    const ixs = await lsdk.withdrawInstruction(
      [mint],
      user.publicKey,
      [user.publicKey],
      [new anchor.BN(0)],
      [mint]
    );
    await txSender.createAndSendV0Tx({
      txInstructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 2_000_000 }),
        ...createMintIxs,
        ...ixs,
        mintToIx,
      ],
      payer: user.publicKey,
      signers: [user, payer, mintKp],
      shouldLog: false,
    });

    const userAmount = await getAmountfromTa(userTa);
    const vaultAmount = await getAmountfromTa(vaultTa);
    const burnAmount = await getAmountfromTa(burnTa);
    const lockerAccount = await program.account.locker.fetch(locker);
    assert.strictEqual(vaultAmount, 0);
    assert.strictEqual(userAmount, amount);
    assert.strictEqual(
      lockerAccount.space.toString(),
      (space.toNumber() + 1).toString()
    );
  });

  it("Withdraw to non-existing locker & mint: u: x, m: x, a: 100", async () => {
    const userIndex = 2;
    const user = users[userIndex];
    const amount = 1e5;
    const withdrawAmount = mantissa.muln(amount);
    const mintKp = Keypair.generate();
    const mint = mintKp.publicKey;
    const [userTa] = PublicKey.findProgramAddressSync(
      [user.publicKey.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const [vaultTa, bump] = PublicKey.findProgramAddressSync(
      [mint.toBuffer(), user.publicKey.toBuffer()],
      program.programId
    );
    const [locker] = PublicKey.findProgramAddressSync(
      [user.publicKey.toBytes()],
      program.programId
    );
    const space = new anchor.BN(0);

    const [burnTa, burnBump] = PublicKey.findProgramAddressSync(
      [mint.toBuffer()],
      program.programId
    );
    const burnAmountBefore = await getAmountfromTa(burnTa);

    const createMintIxs = await createMintInstruction(
      provider.connection,
      payer,
      providerPk,
      providerPk,
      decimals,
      mintKp
    );
    const mintToIx = createMintToInstruction(
      mint,
      userTa,
      payer.publicKey,
      withdrawAmount.toNumber()
    );
    const ixs = await lsdk.withdrawInstruction(
      [mint],
      user.publicKey,
      [user.publicKey],
      [new anchor.BN(0)],
      [mint]
    );
    await txSender.createAndSendV0Tx({
      txInstructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 2_000_000 }),
        ...createMintIxs,
        ...ixs,
        mintToIx,
      ],
      payer: user.publicKey,
      signers: [user, payer, mintKp],
      shouldLog: false,
    });

    const userAmount = await getAmountfromTa(userTa);
    const vaultAmount = await getAmountfromTa(vaultTa);
    const lockerAccount = await program.account.locker.fetch(locker);
    assert.strictEqual(vaultAmount, 0);
    assert.strictEqual(userAmount, amount);
    assert.strictEqual(
      lockerAccount.space.toString(),
      (space.toNumber() + 1).toString()
    );
  });
});

async function getAmountfromTa(ta: anchor.web3.PublicKey): Promise<number> {
  const account = await provider.connection.getParsedAccountInfo(ta);
  if (!account.value) return 0;
  return (account.value.data as any).parsed.info.tokenAmount.uiAmount;
}
