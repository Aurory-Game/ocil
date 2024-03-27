import * as anchor from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import {
  AccountMeta,
  Commitment,
  Connection,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  toWeb3JsPublicKey,
  fromWeb3JsPublicKey,
} from "@metaplex-foundation/umi-web3js-adapters";

import {
  MPL_TOKEN_METADATA_PROGRAM_ID,
  findMetadataPda,
  findTokenRecordPda,
  findMasterEditionPda,
  mplTokenMetadata,
  fetchAllMetadata,
  deserializeMetadata,
  TokenStandard,
} from "@metaplex-foundation/mpl-token-metadata";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import {
  Umi,
  MaybeRpcAccount,
  PublicKey as UmiPublicKey,
  unwrapOption,
} from "@metaplex-foundation/umi";
import { Casier } from "../target/types/casier";
import idl from "../target/idl/casier.json";

export class LockerSDK {
  umi: Umi;
  program: anchor.Program<Casier>;
  adminPk: PublicKey;
  configPDA: anchor.web3.PublicKey;
  lockerPDA: anchor.web3.PublicKey;
  constructor(
    connection: Connection,
    adminPk: PublicKey,
    programId: PublicKey
  ) {
    this.umi = createUmi(connection);
    this.umi.use(mplTokenMetadata());
    const anchorProvider = new anchor.AnchorProvider(connection, {} as any, {
      commitment: connection.commitment,
    });
    this.program = new anchor.Program<Casier>(
      idl as any,
      programId,
      anchorProvider
    );
    this.adminPk = adminPk;
    const [configPDA] = PublicKey.findProgramAddressSync(
      [anchor.utils.bytes.utf8.encode("config")],
      this.program.programId
    );
    this.configPDA = configPDA;
  }

  /**
   * Put pnft first
   * */
  private async orderMints(mints: PublicKey[]): Promise<{
    orderedMints: PublicKey[];
    pnftCount: number;
  }> {
    const metadataPdas = mints.map(
      (mint) =>
        findMetadataPda(this.umi, { mint: fromWeb3JsPublicKey(mint) })[0]
    );
    let pnftCount = 0;
    const orderedMints: PublicKey[] = [];
    const metadatas = await fetchAllMetadata(this.umi, metadataPdas);
    for (let i = 0; i < metadatas.length; i++) {
      if (
        unwrapOption(metadatas[i].tokenStandard) ===
        TokenStandard.ProgrammableNonFungible
      ) {
        orderedMints.unshift(mints[i]);
        pnftCount++;
      } else {
        orderedMints.push(mints[i]);
      }
    }
    return { orderedMints, pnftCount };
  }

  async depositInstruction(
    unorderedMints: PublicKey[],
    userPk: PublicKey,
    depositAmounts: anchor.BN[],
    shouldGoInBurnTa: boolean
  ): Promise<TransactionInstruction[]> {
    const { orderedMints: mints, pnftCount } = await this.orderMints(
      unorderedMints
    );
    const remainingAccounts: Array<AccountMeta> = [];
    const vaultBumps: Array<number> = [];
    const burnBumps: Array<number> = [];
    const [lockerPDA] = PublicKey.findProgramAddressSync(
      [userPk.toBuffer()],
      this.program.programId
    );

    for (let index = 0; index < mints.length; index++) {
      if (index === 0 && pnftCount > 0) {
        remainingAccounts.push({
          pubkey: toWeb3JsPublicKey(MPL_TOKEN_METADATA_PROGRAM_ID),
          isWritable: false,
          isSigner: false,
        });
        remainingAccounts.push({
          pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,
          isWritable: false,
          isSigner: false,
        });
        remainingAccounts.push({
          pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,
          isWritable: false,
          isSigner: false,
        });
      }
      const mint = mints[index];
      const [vaultTa, vaultBump] = PublicKey.findProgramAddressSync(
        [mint.toBuffer(), userPk.toBuffer()],
        this.program.programId
      );
      const [burnTa, burnBump] = PublicKey.findProgramAddressSync(
        [mint.toBuffer()],
        this.program.programId
      );
      vaultBumps.push(vaultBump);
      burnBumps.push(burnBump);
      const userTa = getAssociatedTokenAddressSync(mint, userPk);
      remainingAccounts.push({
        pubkey: mint,
        isWritable: true,
        isSigner: false,
      });
      remainingAccounts.push({
        pubkey: userTa, // user ta
        isWritable: true,
        isSigner: false,
      });
      remainingAccounts.push({
        pubkey: vaultTa,
        isWritable: true,
        isSigner: false,
      });
      remainingAccounts.push({
        pubkey: burnTa,
        isWritable: true,
        isSigner: false,
      });
      const [metadataPda] = findMetadataPda(this.umi, {
        mint: fromWeb3JsPublicKey(mint),
      });
      remainingAccounts.push({
        pubkey: toWeb3JsPublicKey(metadataPda),
        isWritable: true,
        isSigner: false,
      });
      const [tokenRecordSender] = findTokenRecordPda(this.umi, {
        mint: fromWeb3JsPublicKey(mint),
        token: fromWeb3JsPublicKey(userTa),
      });
      const [tokenRecordDestination] = findTokenRecordPda(this.umi, {
        mint: fromWeb3JsPublicKey(mint),
        token: fromWeb3JsPublicKey(vaultTa),
      });
      remainingAccounts.push({
        pubkey: toWeb3JsPublicKey(tokenRecordSender),
        isWritable: true,
        isSigner: false,
      });
      remainingAccounts.push({
        pubkey: toWeb3JsPublicKey(tokenRecordDestination),
        isWritable: true,
        isSigner: false,
      });
      const [editionPk] = await findMasterEditionPda(this.umi, {
        mint: fromWeb3JsPublicKey(mint),
      });
      remainingAccounts.push({
        pubkey: toWeb3JsPublicKey(editionPk),
        isWritable: false,
        isSigner: false,
      });
    }

    const ixs: TransactionInstruction[] = [];
    let nonce = new anchor.BN(0);
    const lockerInitIx = await this.initLockerInstructionIfNeeded(
      userPk,
      lockerPDA
    );
    if (lockerInitIx) {
      ixs.push(lockerInitIx);
    } else {
      const locker = await this.program.account.locker.fetch(lockerPDA);
      nonce = locker.space;
    }
    ixs.push(
      await this.program.methods
        .depositBatch(
          depositAmounts,
          Buffer.from(vaultBumps),
          Buffer.from(burnBumps),
          shouldGoInBurnTa,
          pnftCount,
          nonce
        )
        .accounts({
          config: this.configPDA,
          locker: lockerPDA,
          admin: this.adminPk,
          owner: userPk,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .remainingAccounts(remainingAccounts)
        .instruction()
    );

    return ixs;
  }

  async withdrawInstruction(
    unorderedMints: PublicKey[],
    userPk: PublicKey,
    vaultOwners: PublicKey[],
    withdrawAmounts: anchor.BN[],
    finalAmounts: anchor.BN[]
  ): Promise<TransactionInstruction[]> {
    const { orderedMints: mints, pnftCount } = await this.orderMints(
      unorderedMints
    );
    const remainingAccounts: Array<AccountMeta> = [];
    const vaultBumps: Array<number> = [];
    const burnBumps: Array<number> = [];

    for (let index = 0; index < mints.length; index++) {
      if (index === 0 && pnftCount > 0) {
        remainingAccounts.push({
          pubkey: toWeb3JsPublicKey(MPL_TOKEN_METADATA_PROGRAM_ID),
          isWritable: false,
          isSigner: false,
        });
        remainingAccounts.push({
          pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,
          isWritable: false,
          isSigner: false,
        });
      }
      const mint = mints[index];
      const [burnTa, burnBump] = PublicKey.findProgramAddressSync(
        [mint.toBuffer()],
        this.program.programId
      );
      burnBumps.push(burnBump);
      remainingAccounts.push({
        pubkey: mint,
        isWritable: true,
        isSigner: false,
      });
      const userTa = getAssociatedTokenAddressSync(mint, userPk);
      remainingAccounts.push({
        pubkey: userTa, // user ta
        isWritable: true,
        isSigner: false,
      });
      const vaultOwner = vaultOwners[index];
      const [vaultTa, vaultBump] = PublicKey.findProgramAddressSync(
        [mint.toBuffer(), vaultOwner.toBuffer()],
        this.program.programId
      );
      remainingAccounts.push({
        pubkey: vaultTa,
        isWritable: true,
        isSigner: false,
      });
      remainingAccounts.push({
        pubkey: vaultOwner,
        isWritable: true,
        isSigner: false,
      });
      remainingAccounts.push({
        pubkey: burnTa,
        isWritable: true,
        isSigner: false,
      });
      vaultBumps.push(vaultBump);
      const [metadataPda] = findMetadataPda(this.umi, {
        mint: fromWeb3JsPublicKey(mint),
      });
      remainingAccounts.push({
        pubkey: toWeb3JsPublicKey(metadataPda),
        isWritable: true,
        isSigner: false,
      });
      const [tokenRecordSender] = findTokenRecordPda(this.umi, {
        mint: fromWeb3JsPublicKey(mint),
        token: fromWeb3JsPublicKey(vaultTa),
      });
      const [tokenRecordDestination] = findTokenRecordPda(this.umi, {
        mint: fromWeb3JsPublicKey(mint),
        token: fromWeb3JsPublicKey(userTa),
      });
      remainingAccounts.push({
        pubkey: toWeb3JsPublicKey(tokenRecordSender),
        isWritable: true,
        isSigner: false,
      });
      remainingAccounts.push({
        pubkey: toWeb3JsPublicKey(tokenRecordDestination),
        isWritable: true,
        isSigner: false,
      });
      const [editionPk] = await findMasterEditionPda(this.umi, {
        mint: fromWeb3JsPublicKey(mint),
      });
      remainingAccounts.push({
        pubkey: toWeb3JsPublicKey(editionPk),
        isWritable: false,
        isSigner: false,
      });
    }

    const [lockerPDA] = PublicKey.findProgramAddressSync(
      [userPk.toBuffer()],
      this.program.programId
    );
    const ixs: TransactionInstruction[] = [];
    let nonce = new anchor.BN(0);
    const lockerInitIx = await this.initLockerInstructionIfNeeded(
      userPk,
      lockerPDA
    );
    if (lockerInitIx) {
      ixs.push(lockerInitIx);
    } else {
      const locker = await this.program.account.locker.fetch(lockerPDA);
      nonce = locker.space;
    }

    ixs.push(
      await this.program.methods
        .withdrawV2Batch(
          withdrawAmounts,
          finalAmounts,
          Buffer.from(vaultBumps),
          Buffer.from(burnBumps),
          pnftCount,
          nonce
        )
        .accounts({
          config: this.configPDA,
          locker: lockerPDA,
          admin: this.adminPk,
          userTaOwner: userPk,
          vaultTaOwner: userPk,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .remainingAccounts(remainingAccounts)
        .instruction()
    );

    return ixs;
  }

  private async initLockerInstructionIfNeeded(
    owner: PublicKey,
    lockerPDA: PublicKey
  ): Promise<TransactionInstruction | null> {
    let exists = false;
    try {
      const account: MaybeRpcAccount = (await this.umi.rpc.getAccount(
        fromWeb3JsPublicKey(lockerPDA)
      )) as MaybeRpcAccount;
      exists = account?.exists;
    } catch (e) {}

    if (!exists) {
      return (
        this.program.methods
          .initLockerV2()
          .accounts({
            locker: lockerPDA,
            owner: owner,
            systemProgram: SystemProgram.programId,
            rent: SYSVAR_RENT_PUBKEY,
          })
          // .signers([this.signer])
          .instruction()
      );
    }
    return null;
  }
}
