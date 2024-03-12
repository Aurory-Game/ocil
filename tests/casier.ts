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
} from "@solana/spl-token";
import { assert } from "chai";
import { TxSender } from "./utils";

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

describe("casier", () => {
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
            0,
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
              300
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
  });

  it("Is initialized!", async () => {
    // Add your test here.
    const tx = await program.methods.initialize().rpc();
  });

  it("Init config", async () => {
    // Add your test here.

    const tx = await program.methods
      .initConfig()
      .accounts({
        config: configPDA,
        feePayer: providerPk,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();
  });

  it("Init locker", async () => {
    const space = new anchor.BN(500);
    const userIndex = 0;
    const txs = await Promise.all(
      users.map((user, userIndex) =>
        program.methods
          .initLocker(space)
          .accounts({
            locker: lockerPDAs[userIndex],
            owner: user.publicKey,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .signers([user])
          .rpc()
      )
    );

    const lockerAccount = await program.account.locker.fetch(
      lockerPDAs[userIndex]
    );
    assert.strictEqual(lockerAccount.space.toString(), space.toString());
    assert.strictEqual(
      lockerAccount.owner.toString(),
      users[0].publicKey.toString()
    );
  });

  it("Deposit to closed vault TA: u: 0, m: 0, a: 100", async () => {
    const userIndex = 0;
    const mintIndex = 0;
    const deposit_amount = new anchor.BN(100);

    const { beforeAmount, finalAmount } = await getCheckAmounts(
      "deposit",
      userIndex,
      mintIndex,
      deposit_amount
    );

    const user = users[userIndex];
    const mint = mints[mintIndex];
    const userTa = tokenAccounts[userIndex][mintIndex];
    const vaultTa = vaultTAs[userIndex][mintIndex];
    const vaultBump = vaultTABumps[userIndex][mintIndex];
    const locker = lockerPDAs[userIndex];

    const should_go_in_burn_ta = false;
    const [burnTa, burnBump] = await PublicKey.findProgramAddress(
      [mint.toBuffer()],
      program.programId
    );
    const tx = await program.methods
      .deposit(
        vaultBump,
        deposit_amount,
        beforeAmount,
        burnBump,
        should_go_in_burn_ta
      )
      .accounts({
        config: configPDA,
        locker,
        mint: mint,
        owner: user.publicKey,
        admin: providerPk,
        burnTa,
        userTa,
        vaultTa,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([user, payer])
      .rpc();

    await afterChecks(mintIndex, vaultTa, locker, finalAmount, mint);
  });

  it("Deposit to closed vault TA second mint: u: 0, m: 1, a: 100", async () => {
    const userIndex = 0;
    const mintIndex = 1;
    const deposit_amount = new anchor.BN(100);

    const { beforeAmount, finalAmount } = await getCheckAmounts(
      "deposit",
      userIndex,
      mintIndex,
      deposit_amount
    );

    const user = users[userIndex];
    const mint = mints[mintIndex];
    const userTa = tokenAccounts[userIndex][mintIndex];
    const vaultTa = vaultTAs[userIndex][mintIndex];
    const vaultBump = vaultTABumps[userIndex][mintIndex];
    const locker = lockerPDAs[userIndex];

    const should_go_in_burn_ta = false;
    const [burnTa, burnBump] = await PublicKey.findProgramAddress(
      [mint.toBuffer()],
      program.programId
    );
    const tx = await program.methods
      .deposit(
        vaultBump,
        deposit_amount,
        beforeAmount,
        burnBump,
        should_go_in_burn_ta
      )
      .accounts({
        config: configPDA,
        locker,
        mint: mint,
        owner: user.publicKey,
        admin: providerPk,
        burnTa,
        userTa,
        vaultTa,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([user, payer])
      .rpc();

    await afterChecks(mintIndex, vaultTa, locker, finalAmount, mint);
  });

  // user 0, mint 0, amount 100
  it("Deposit to opened vault TA: u: 0, m: 0, a: 100", async () => {
    const userIndex = 0;
    const mintIndex = 0;
    const deposit_amount = new anchor.BN(100);

    const { beforeAmount, finalAmount } = await getCheckAmounts(
      "deposit",
      userIndex,
      mintIndex,
      deposit_amount
    );

    const user = users[userIndex];
    const mint = mints[mintIndex];
    const userTa = tokenAccounts[userIndex][mintIndex];
    const vaultTa = vaultTAs[userIndex][mintIndex];
    const vaultBump = vaultTABumps[userIndex][mintIndex];
    const locker = lockerPDAs[userIndex];

    const should_go_in_burn_ta = false;
    const [burnTa, burnBump] = await PublicKey.findProgramAddress(
      [mint.toBuffer()],
      program.programId
    );
    const tx = await program.methods
      .deposit(
        vaultBump,
        deposit_amount,
        beforeAmount,
        burnBump,
        should_go_in_burn_ta
      )
      .accounts({
        config: configPDA,
        locker,
        mint: mint,
        owner: user.publicKey,
        admin: providerPk,
        burnTa,
        userTa,
        vaultTa,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([user, payer])
      .rpc();

    await afterChecks(mintIndex, vaultTa, locker, finalAmount, mint);
  });

  it("WithdrawV2 from userTa: u: 0, m: 0, a: 100", async () => {
    const userIndex = 0;
    const mintIndex = 0;
    const withdrawAmount = new anchor.BN(100);
    const withTransfer = true;

    const { beforeAmount, finalAmount } = await getCheckAmounts(
      "withdraw",
      userIndex,
      mintIndex,
      withdrawAmount,
      withTransfer
    );
    const user = users[userIndex];
    const mint = mints[mintIndex];
    const userTa = tokenAccounts[userIndex][mintIndex];
    const vaultBump = vaultTABumps[userIndex][mintIndex];
    const vaultTa = vaultTAs[userIndex][mintIndex];
    const locker = lockerPDAs[userIndex];

    const [burnTa, burn_bump] = await PublicKey.findProgramAddress(
      [mint.toBuffer()],
      program.programId
    );

    const tx = await program.methods
      .withdrawV2(
        vaultBump,
        burn_bump,
        withdrawAmount,
        beforeAmount,
        finalAmount
      )
      .accounts({
        config: configPDA,
        locker,
        mint: mint,
        admin: providerPk,
        userTa,
        userTaOwner: user.publicKey,
        vaultTa,
        vaultTaOwner: user.publicKey,
        burnTa,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([user, payer])
      .rpc();

    const burnTokenAccount = await provider.connection.getParsedAccountInfo(
      burnTa
    );
    const vaultAccount = await provider.connection.getParsedAccountInfo(
      vaultTa
    );

    await afterChecks(mintIndex, vaultTa, locker, finalAmount, mint);
  });

  it("Deposit to closed burnTA: u: 0, m: 0, a: 1", async () => {
    const userIndex = 0;
    const mintIndex = 0;
    const deposit_amount = new anchor.BN(1);

    const { beforeAmount, finalAmount } = await getCheckAmounts(
      "deposit",
      userIndex,
      mintIndex,
      deposit_amount
    );

    const user = users[userIndex];
    const mint = mints[mintIndex];
    const userTa = tokenAccounts[userIndex][mintIndex];
    const vaultTa = vaultTAs[userIndex][mintIndex];
    const vaultBump = vaultTABumps[userIndex][mintIndex];
    const locker = lockerPDAs[userIndex];

    const should_go_in_burn_ta = true;
    const [burnTa, burnBump] = await PublicKey.findProgramAddress(
      [mint.toBuffer()],
      program.programId
    );
    const tx = await program.methods
      .deposit(
        vaultBump,
        deposit_amount,
        beforeAmount,
        burnBump,
        should_go_in_burn_ta
      )
      .accounts({
        config: configPDA,
        locker,
        mint: mint,
        owner: user.publicKey,
        admin: providerPk,
        burnTa,
        userTa,
        vaultTa,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([user, payer])
      .rpc();

    const burnAccount = await provider.connection.getParsedAccountInfo(burnTa);
    assert.strictEqual(
      (
        burnAccount.value.data as any
      ).parsed.info.tokenAmount.uiAmount.toString(),
      finalAmount.toString()
    );
  });

  it("Deposit to opened burnTA: u: 0, m: 0, a: 1", async () => {
    const userIndex = 0;
    const mintIndex = 0;
    const deposit_amount = new anchor.BN(1);

    const { beforeAmount, finalAmount } = await getCheckAmounts(
      "deposit",
      userIndex,
      mintIndex,
      deposit_amount
    );

    const user = users[userIndex];
    const mint = mints[mintIndex];
    const userTa = tokenAccounts[userIndex][mintIndex];
    const vaultTa = vaultTAs[userIndex][mintIndex];
    const vaultBump = vaultTABumps[userIndex][mintIndex];
    const locker = lockerPDAs[userIndex];

    const should_go_in_burn_ta = true;
    const [burnTa, burnBump] = await PublicKey.findProgramAddress(
      [mint.toBuffer()],
      program.programId
    );
    const tx = await program.methods
      .deposit(
        vaultBump,
        deposit_amount,
        beforeAmount,
        burnBump,
        should_go_in_burn_ta
      )
      .accounts({
        config: configPDA,
        locker,
        mint: mint,
        owner: user.publicKey,
        admin: providerPk,
        burnTa,
        userTa,
        vaultTa,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([user, payer])
      .rpc();

    const burnAccount = await provider.connection.getParsedAccountInfo(burnTa);
    assert.strictEqual(
      (
        burnAccount.value.data as any
      ).parsed.info.tokenAmount.uiAmount.toString(),
      finalAmount.toString()
    );
  });

  it("WithdrawV2 from burnTa: u: 0, m: 0, a: 1", async () => {
    const userIndex = 0;
    const mintIndex = 0;
    const withdrawAmount = new anchor.BN(1);
    const withTransfer = true;

    const { beforeAmount, finalAmount } = await getCheckAmounts(
      "withdraw",
      userIndex,
      mintIndex,
      withdrawAmount,
      withTransfer
    );
    const user = users[userIndex];
    const mint = mints[mintIndex];
    const userTa = tokenAccounts[userIndex][mintIndex];
    const vaultBump = vaultTABumps[userIndex][mintIndex];
    const vaultTa = vaultTAs[userIndex][mintIndex];
    const locker = lockerPDAs[userIndex];

    const [burnTa, burn_bump] = await PublicKey.findProgramAddress(
      [mint.toBuffer()],
      program.programId
    );

    const burnAccountBefore = await provider.connection.getParsedAccountInfo(
      burnTa
    );
    const burnTaAmountBefore = (burnAccountBefore.value.data as any).parsed.info
      .tokenAmount.uiAmount;

    const tx = await program.methods
      .withdrawV2(
        vaultBump,
        burn_bump,
        withdrawAmount,
        beforeAmount,
        finalAmount
      )
      .accounts({
        config: configPDA,
        locker,
        mint: mint,
        admin: providerPk,
        userTa,
        userTaOwner: user.publicKey,
        vaultTa: burnTa,
        vaultTaOwner: user.publicKey,
        burnTa,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([user, payer])
      .rpc();

    const burnAccountAfter = await provider.connection.getParsedAccountInfo(
      burnTa
    );
    const burnTaAmountAfter = (burnAccountAfter.value.data as any).parsed.info
      .tokenAmount.uiAmount;
    assert.strictEqual(burnTaAmountAfter + 1, burnTaAmountBefore);
  });

  it("WithdrawV2 from burnTa for user who never deposited: u: 0, m: 0, a: 1", async () => {
    const userIndex = 2;
    const mintIndex = 0;
    const withdrawAmount = new anchor.BN(1);
    const withTransfer = true;

    const { beforeAmount, finalAmount } = await getCheckAmounts(
      "withdraw",
      userIndex,
      mintIndex,
      withdrawAmount,
      withTransfer
    );
    const user = users[userIndex];
    const mint = mints[mintIndex];
    const userTa = tokenAccounts[userIndex][mintIndex];
    const vaultBump = vaultTABumps[userIndex][mintIndex];
    const vaultTa = vaultTAs[userIndex][mintIndex];
    const locker = lockerPDAs[userIndex];

    const [burnTa, burn_bump] = await PublicKey.findProgramAddress(
      [mint.toBuffer()],
      program.programId
    );

    const burnAccountBefore = await provider.connection.getParsedAccountInfo(
      burnTa
    );
    const burnTaAmountBefore = (burnAccountBefore.value.data as any).parsed.info
      .tokenAmount.uiAmount;

    const tx = await program.methods
      .withdrawV2(
        vaultBump,
        burn_bump,
        withdrawAmount,
        beforeAmount,
        finalAmount
      )
      .accounts({
        config: configPDA,
        locker,
        mint: mint,
        admin: providerPk,
        userTa,
        userTaOwner: user.publicKey,
        vaultTa: burnTa,
        vaultTaOwner: user.publicKey,
        burnTa,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([user, payer])
      .rpc();

    const burnAccountAfter = await provider.connection.getParsedAccountInfo(
      burnTa
    );
    const burnTaAmountAfter = (burnAccountAfter.value.data as any).parsed.info
      .tokenAmount.uiAmount;
    assert.strictEqual(burnTaAmountAfter + 1, burnTaAmountBefore);
  });

  it("Deposit batch", async () => {
    const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({
      units: 1400000,
    });
    const { blockhash } = await provider.connection.getLatestBlockhash();
    const userIndex = 0;
    const depositAmounts = mints.map((v, i) => new anchor.BN(i + 1));
    const beforeAmounts = [];
    const finalAmounts = [];
    const remainingAccounts = [];
    const burnBumps = [];
    const vaultBumps = [];
    const vaultFinalAmounts = [];

    for (let index = 0; index < mints.length; index++) {
      const mint = mints[index];
      const { beforeAmount, finalAmount, vaultFinalAmount } =
        await getCheckAmountsV2(
          "deposit",
          userIndex,
          index,
          depositAmounts[index]
        );
      vaultFinalAmounts.push(vaultFinalAmount);
      beforeAmounts.push(beforeAmount);
      finalAmounts.push(finalAmount);
      const [burnTa, burnBump] = PublicKey.findProgramAddressSync(
        [mint.toBuffer()],
        program.programId
      );
      burnBumps.push(burnBump);
      remainingAccounts.push({
        pubkey: mint,
        isWritable: true,
        isSigner: false,
      });
      remainingAccounts.push({
        pubkey: tokenAccounts[userIndex][index], // user ta
        isWritable: true,
        isSigner: false,
      });
      remainingAccounts.push({
        pubkey: vaultTAs[userIndex][index],
        isWritable: true,
        isSigner: false,
      });
      remainingAccounts.push({
        pubkey: burnTa,
        isWritable: true,
        isSigner: false,
      });
      vaultBumps.push(vaultTABumps[userIndex][index]);
    }

    const user = users[userIndex];
    const depositInstruction = await program.methods
      .depositBatch(
        depositAmounts,
        beforeAmounts,
        Buffer.from(vaultBumps),
        Buffer.from(burnBumps),
        false, // set to 'true' if you want to go to burn TA, otherwise 'false'
        0 // pnft count
      )
      .accounts({
        config: configPDA,
        locker: lockerPDAs[userIndex],
        admin: providerPk,
        owner: user.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .remainingAccounts(remainingAccounts)
      .instruction();

    await txSender.createAndSendV0Tx({
      txInstructions: [modifyComputeUnits, depositInstruction],
      payer: payer.publicKey,
      signers: [signer, user],
      lookupTableAccount: lookupTable,
    });

    for (let mintIndex = 0; mintIndex < mints.length; mintIndex++) {
      await afterChecksV2(
        mintIndex,
        vaultTAs[userIndex][mintIndex],
        lockerPDAs[userIndex],
        finalAmounts[mintIndex],
        mints[mintIndex],
        vaultFinalAmounts[mintIndex]
      );
    }
  });

  it("Withdraw v2 batch", async () => {
    const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({
      units: 1400000,
    });
    const { blockhash } = await provider.connection.getLatestBlockhash();
    const userIndex = 0;
    const withdrawAmounts = mints.map((v, i) => new anchor.BN(i + 1));
    const beforeAmounts = [];
    const finalAmounts = [];
    const remainingAccounts = [];
    const burnBumps = [];
    const vaultBumps = [];
    const vaultFinalAmounts = [];
    const withTransfer = true;

    for (let index = 0; index < mints.length; index++) {
      const mint = mints[index];
      const { beforeAmount, finalAmount, vaultFinalAmount } =
        await getCheckAmountsV2(
          "withdraw",
          userIndex,
          index,
          withdrawAmounts[index]
        );
      vaultFinalAmounts.push(vaultFinalAmount);
      beforeAmounts.push(beforeAmount);
      finalAmounts.push(finalAmount);
      const [burnTa, burnBump] = PublicKey.findProgramAddressSync(
        [mint.toBuffer()],
        program.programId
      );
      burnBumps.push(burnBump);
      remainingAccounts.push({
        pubkey: mint,
        isWritable: true,
        isSigner: false,
      });
      remainingAccounts.push({
        pubkey: tokenAccounts[userIndex][index], // user ta
        isWritable: true,
        isSigner: false,
      });
      remainingAccounts.push({
        pubkey: vaultTAs[userIndex][index],
        isWritable: true,
        isSigner: false,
      });
      remainingAccounts.push({
        pubkey: users[userIndex].publicKey,
        isWritable: true,
        isSigner: false,
      });
      remainingAccounts.push({
        pubkey: burnTa,
        isWritable: true,
        isSigner: false,
      });
      vaultBumps.push(vaultTABumps[userIndex][index]);
    }

    const vaultAccount = await provider.connection.getParsedAccountInfo(
      vaultTAs[userIndex][0]
    );

    const user = users[userIndex];
    const withdrawInstruction = await program.methods
      .withdrawV2Batch(
        withdrawAmounts,
        beforeAmounts,
        finalAmounts,
        Buffer.from(vaultBumps),
        Buffer.from(burnBumps)
      )
      .accounts({
        config: configPDA,
        locker: lockerPDAs[userIndex],
        admin: providerPk,
        userTaOwner: user.publicKey,
        vaultTaOwner: user.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .remainingAccounts(remainingAccounts)
      .instruction();

    await txSender.createAndSendV0Tx({
      txInstructions: [modifyComputeUnits, withdrawInstruction],
      payer: payer.publicKey,
      signers: [signer, user],
      lookupTableAccount: lookupTable,
    });

    for (let mintIndex = 0; mintIndex < mints.length; mintIndex++) {
      await afterChecksV2(
        mintIndex,
        vaultTAs[userIndex][mintIndex],
        lockerPDAs[userIndex],
        finalAmounts[mintIndex],
        mints[mintIndex],
        vaultFinalAmounts[mintIndex]
      );
    }
  });
});

async function getCheckAmounts(
  txType: "deposit" | "withdraw",
  userIndex: number,
  mintIndex: number,
  withdrawAmount: anchor.BN,
  withTransfer: boolean = true
): Promise<{
  beforeAmount: anchor.BN;
  finalAmount: anchor.BN;
  lockerAccount: any;
  lockerMintIndex: number;
}> {
  const lockerAccount = await program.account.locker.fetch(
    lockerPDAs[userIndex]
  );
  const lockerMintIndex = lockerAccount.mints.findIndex(
    (v) => v.toString() === mints[mintIndex].toString()
  );
  let beforeAmount =
    lockerMintIndex !== -1
      ? lockerAccount.amounts[lockerMintIndex]
      : new anchor.BN(0);
  const sign = txType == "deposit" ? new anchor.BN(1) : new anchor.BN(-1);
  let finalAmount = withTransfer
    ? beforeAmount.add(sign.mul(withdrawAmount))
    : beforeAmount;
  return { beforeAmount, finalAmount, lockerAccount, lockerMintIndex };
}

async function getCheckAmountsV2(
  txType: "deposit" | "withdraw",
  userIndex: number,
  mintIndex: number,
  amount: anchor.BN,
  withTransfer: boolean = true
): Promise<{
  beforeAmount: anchor.BN;
  finalAmount: anchor.BN;
  lockerAccount: any;
  lockerMintIndex: number;
  vaultFinalAmount: anchor.BN;
}> {
  const lockerAccount = await program.account.locker.fetch(
    lockerPDAs[userIndex]
  );
  const lockerMintIndex = lockerAccount.mints.findIndex(
    (v) => v.toString() === mints[mintIndex].toString()
  );
  let beforeAmount =
    lockerMintIndex !== -1
      ? lockerAccount.amounts[lockerMintIndex]
      : new anchor.BN(0);
  const sign = txType == "deposit" ? new anchor.BN(1) : new anchor.BN(-1);
  let finalAmount = withTransfer
    ? beforeAmount.add(sign.mul(amount))
    : beforeAmount;
  const vaultAccount = await provider.connection.getParsedAccountInfo(
    vaultTAs[userIndex][mintIndex]
  );
  const vaultAmount = (
    vaultAccount?.value?.data as any
  )?.parsed?.info?.tokenAmount?.uiAmount?.toString();
  const vaultBeforeAmount = vaultAmount
    ? new anchor.BN(vaultAmount)
    : new anchor.BN(0);
  const vaultFinalAmount = vaultBeforeAmount.add(sign.mul(amount));
  return {
    beforeAmount,
    finalAmount,
    lockerAccount,
    lockerMintIndex,
    vaultFinalAmount,
  };
}

async function afterChecks(
  mintIndex: number,
  vaultTa: anchor.web3.PublicKey,
  locker: anchor.web3.PublicKey,
  finalAmount: anchor.BN,
  mint: string
): Promise<void> {
  const vaultAccount = await provider.connection.getParsedAccountInfo(vaultTa);
  const lockerAccount = await program.account.locker.fetch(locker);
  const lockerMintIndex = lockerAccount.mints.findIndex(
    (v) => v.toString() === mints[mintIndex].toString()
  );

  if (finalAmount.toString() !== "0") {
    assert.strictEqual(
      lockerAccount.amounts[lockerMintIndex].toString(),
      finalAmount.toString()
    );
    assert.strictEqual(
      lockerAccount.mints[lockerMintIndex].toString(),
      mint.toString()
    );
    assert.strictEqual(
      (
        vaultAccount.value.data as any
      ).parsed.info.tokenAmount.uiAmount.toString(),
      finalAmount.toString()
    );
  } else {
    assert.isNull(vaultAccount.value);
    assert.strictEqual(lockerMintIndex, -1);
  }
}

async function afterChecksV2(
  mintIndex: number,
  vaultTa: anchor.web3.PublicKey,
  locker: anchor.web3.PublicKey,
  finalAmount: anchor.BN,
  mint: string,
  vaultFinalAmount: anchor.BN
): Promise<void> {
  const vaultAccount = await provider.connection.getParsedAccountInfo(vaultTa);
  const lockerAccount = await program.account.locker.fetch(locker);
  const lockerMintIndex = lockerAccount.mints.findIndex(
    (v) => v.toString() === mints[mintIndex].toString()
  );

  if (finalAmount.toString() !== "0") {
    assert.strictEqual(
      lockerAccount.amounts[lockerMintIndex].toString(),
      finalAmount.toString()
    );
    assert.strictEqual(
      lockerAccount.mints[lockerMintIndex].toString(),
      mint.toString()
    );
  } else {
    assert.isNull(vaultAccount.value);
    assert.strictEqual(lockerMintIndex, -1);
  }
  if (vaultFinalAmount.toString() !== "0") {
    assert.strictEqual(
      (
        vaultAccount.value.data as any
      ).parsed.info.tokenAmount.uiAmount.toString(),
      vaultFinalAmount.toString()
    );
  } else {
    assert.isNull(vaultAccount.value);
  }
}

async function getTransaction(
  signature: string,
  connection: Connection,
  log: boolean = false
): Promise<ParsedTransactionWithMeta> {
  let ptx = null;
  while (ptx === null) {
    ptx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (log) {
    ptx?.meta?.logMessages
      ? ptx?.meta?.logMessages?.forEach((log) => {
          console.log(log);
        })
      : console.log(ptx);
  }
  return ptx;
}
