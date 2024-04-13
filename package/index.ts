import * as anchor from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import {
  AccountMeta,
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
  toWeb3JsInstruction,
} from "@metaplex-foundation/umi-web3js-adapters";

import {
  MPL_TOKEN_METADATA_PROGRAM_ID,
  findMetadataPda,
  findTokenRecordPda,
  findMasterEditionPda,
  mplTokenMetadata,
  TokenStandard,
  safeFetchMetadata,
} from "@metaplex-foundation/mpl-token-metadata";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import {
  Umi,
  MaybeRpcAccount,
  PublicKey as UmiPublicKey,
  unwrapOption,
  signerIdentity,
  createNoopSigner,
} from "@metaplex-foundation/umi";
import { Casier } from "../target/types/casier";
import idl from "../target/idl/casier.json";
import {
  MPL_CORE_PROGRAM_ID,
  fetchAllAssetV1,
  fetchCollectionV1,
  safeFetchCollectionV1,
  transferV1,
  updatePluginV1,
  createPlugin,
  addressPluginAuthority,
  PluginType,
  revokePluginAuthorityV1,
  approvePluginAuthorityV1,
} from "@metaplex-foundation/mpl-core";

export class LockerSDK {
  umi: Umi;
  program: anchor.Program<Casier>;
  adminPk: PublicKey;
  configPDA: PublicKey;
  lockerPDA: PublicKey;
  connection: Connection;
  coreAssetsAuthority: anchor.web3.PublicKey;
  constructor(
    connection: Connection,
    adminPk: PublicKey,
    programId: PublicKey,
    coreAssetsAuthority?: PublicKey
  ) {
    this.connection = connection;
    this.umi = createUmi(connection);
    this.umi.use(
      signerIdentity(createNoopSigner(fromWeb3JsPublicKey(adminPk)))
    );
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
    this.coreAssetsAuthority = coreAssetsAuthority;
  }

  /**
   * Put assets and amounts in order: core, pnft, spl
   * */
  public async orderMints(
    mints: PublicKey[],
    unorderedAmounts: anchor.BN[]
  ): Promise<{
    orderedMints: PublicKey[];
    pnftCount: number;
    coreCount: number;
    orderedAmounts: anchor.BN[];
  }> {
    const accountInfoArr = await Promise.all(
      mints.map(async (mint) => {
        return this.connection.getAccountInfo(mint);
      })
    );
    const orderedMintsWithoutCore: PublicKey[] = [];
    const coreAsset = [];
    const orderedAmounts: anchor.BN[] = [];
    const nonCoreAmounts: anchor.BN[] = [];
    let pnftCount = 0;
    for (let i = 0; i < accountInfoArr.length; i++) {
      const mint = mints[i];
      const amount = unorderedAmounts[i];
      const accountInfo = accountInfoArr[i];
      if (accountInfo) {
        const programId = accountInfo.owner;
        if (programId.equals(toWeb3JsPublicKey(MPL_CORE_PROGRAM_ID))) {
          coreAsset.push(mint);
          orderedAmounts.push(amount);
        } else {
          const metadata = await safeFetchMetadata(
            this.umi,
            findMetadataPda(this.umi, {
              mint: fromWeb3JsPublicKey(mint),
            })[0]
          );
          if (
            metadata &&
            unwrapOption(metadata.tokenStandard) ===
              TokenStandard.ProgrammableNonFungible
          ) {
            orderedMintsWithoutCore.unshift(mint);
            nonCoreAmounts.unshift(amount);
            pnftCount++;
          } else {
            orderedMintsWithoutCore.push(mint);
            nonCoreAmounts.push(amount);
          }
        }
      }
    }

    orderedAmounts.push(...nonCoreAmounts);

    const orderedMints = coreAsset.concat(orderedMintsWithoutCore);
    if (orderedMints.length !== mints.length) {
      throw new Error("mints and orderedMints length mismatch");
    }
    return {
      orderedMints,
      pnftCount,
      coreCount: coreAsset.length,
      orderedAmounts,
    };
  }

  async depositCoreInstruction(
    coreMints: UmiPublicKey[],
    owner: UmiPublicKey
  ): Promise<TransactionInstruction[]> {
    const assets = await fetchAllAssetV1(this.umi, coreMints);
    const ixs: TransactionInstruction[] = [];

    const collections = {};
    for (let i = 0; i < assets.length; i++) {
      const asset = assets[i];
      if (asset?.updateAuthority?.type !== "Collection") {
        throw new Error(
          "updateAuthority should be a collection for core assets"
        );
      } else if (!asset?.updateAuthority?.address) {
        throw new Error("missing updateAuthority address");
      }
      let collection;
      if (collections[asset.updateAuthority.address.toString()]) {
        collection = collections[asset.updateAuthority.address.toString()];
      } else {
        collection = await safeFetchCollectionV1(
          this.umi,
          asset.updateAuthority.address
        );
        if (!collection) {
          throw new Error(
            `Collection (${asset.updateAuthority.address.toString()}) not found for asset ${asset.publicKey.toString()}`
          );
        }
        collections[asset.updateAuthority.address.toString()] = collection;
      }
      await fetchCollectionV1(this.umi, asset.updateAuthority.address);
      const freezeIx = updatePluginV1(this.umi, {
        asset: asset.publicKey,
        plugin: createPlugin({
          type: "PermanentFreezeDelegate",
          data: {
            frozen: true,
          },
        }),
        collection,
      })
        .getInstructions()
        .map((instruction) => toWeb3JsInstruction(instruction));
      ixs.push(...freezeIx);
      const transferIx = approvePluginAuthorityV1(this.umi, {
        asset: asset.publicKey,
        collection,
        pluginType: PluginType.TransferDelegate,
        authority: createNoopSigner(owner),
        newAuthority: addressPluginAuthority(fromWeb3JsPublicKey(this.adminPk)),
      })
        .getInstructions()
        .map((instruction) => toWeb3JsInstruction(instruction));
      ixs.push(...transferIx);
    }
    return ixs;
  }

  async depositInstruction(
    unorderedMints: PublicKey[],
    userPk: PublicKey,
    unorderedDepositAmounts: anchor.BN[]
  ): Promise<TransactionInstruction[]> {
    const {
      orderedMints,
      pnftCount,
      coreCount,
      orderedAmounts: depositAmounts,
    } = await this.orderMints(unorderedMints, unorderedDepositAmounts);

    const ixs: TransactionInstruction[] = [];
    const [lockerPDA] = PublicKey.findProgramAddressSync(
      [userPk.toBuffer()],
      this.program.programId
    );
    const lockerInitIx = await this.initLockerInstructionIfNeeded(
      userPk,
      lockerPDA
    );
    let nonce = new anchor.BN(0);

    if (lockerInitIx) {
      ixs.push(lockerInitIx);
    } else {
      const locker = await this.program.account.locker.fetch(lockerPDA);
      nonce = locker.space;
    }

    if (coreCount > 0) {
      const coreIxs = await this.depositCoreInstruction(
        orderedMints.slice(0, coreCount).map((m) => fromWeb3JsPublicKey(m)),
        fromWeb3JsPublicKey(userPk)
      );
      const onlyCore = coreCount === orderedMints.length;
      if (onlyCore) {
        ixs.push(
          await this.program.methods
            .incNonce(nonce)
            .accounts({
              config: this.configPDA,
              locker: lockerPDA,
              admin: this.adminPk,
            })
            .instruction()
        );
        ixs.push(...coreIxs);
        return ixs;
      }
      ixs.push(...coreIxs);
    }

    const standardAndPnftIxs = await this.depositStandardAndPnftInstruction(
      orderedMints.slice(coreCount),
      pnftCount,
      userPk,
      depositAmounts.slice(coreCount),
      nonce,
      lockerPDA
    );
    ixs.push(...standardAndPnftIxs);

    return ixs;
  }

  async depositStandardAndPnftInstruction(
    mints: PublicKey[],
    pnftCount: number,
    userPk: PublicKey,
    depositAmounts: anchor.BN[],
    nonce: anchor.BN,
    lockerPDA: PublicKey
  ): Promise<anchor.web3.TransactionInstruction[]> {
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
      if (index < pnftCount) {
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
          token: fromWeb3JsPublicKey(burnTa),
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
    }

    const ixs: TransactionInstruction[] = [];
    ixs.push(
      await this.program.methods
        .depositBatch(
          depositAmounts,
          Buffer.from(vaultBumps),
          Buffer.from(burnBumps),
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
    unorderedWithdrawAmounts: anchor.BN[]
  ): Promise<TransactionInstruction[]> {
    const {
      orderedMints,
      pnftCount,
      coreCount,
      orderedAmounts: withdrawAmounts,
    } = await this.orderMints(unorderedMints, unorderedWithdrawAmounts);

    const ixs: TransactionInstruction[] = [];

    const [lockerPDA] = PublicKey.findProgramAddressSync(
      [userPk.toBuffer()],
      this.program.programId
    );
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

    if (coreCount > 0) {
      const coreIxs = await this.withdrawCoreInstruction(
        orderedMints.slice(0, coreCount).map((m) => fromWeb3JsPublicKey(m)),
        fromWeb3JsPublicKey(userPk)
      );
      const onlyCore = coreCount === orderedMints.length;
      if (onlyCore) {
        ixs.push(
          await this.program.methods
            .incNonce(nonce)
            .accounts({
              config: this.configPDA,
              locker: lockerPDA,
              admin: this.adminPk,
            })
            .instruction()
        );
        ixs.push(...coreIxs);
        return ixs;
      }
      ixs.push(...coreIxs);
    }

    const standardAndPnftIxs = await this.withdrawStandardAndPnftInstruction(
      orderedMints.slice(coreCount),
      pnftCount,
      userPk,
      withdrawAmounts.slice(coreCount),
      nonce,
      lockerPDA,
      vaultOwners
    );
    ixs.push(...standardAndPnftIxs);

    return ixs;
  }

  async withdrawStandardAndPnftInstruction(
    mints: anchor.web3.PublicKey[],
    pnftCount: number,
    userPk: anchor.web3.PublicKey,
    withdrawAmounts: any,
    nonce: anchor.BN,
    lockerPDA: anchor.web3.PublicKey,
    vaultOwners: PublicKey[]
  ): Promise<TransactionInstruction[]> {
    const ixs: TransactionInstruction[] = [];
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
      if (index < pnftCount) {
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
          token: fromWeb3JsPublicKey(burnTa),
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
    }

    ixs.push(
      await this.program.methods
        .withdrawV2Batch(
          withdrawAmounts,
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

  async withdrawCoreInstruction(
    mints: UmiPublicKey[],
    userPk: UmiPublicKey
  ): Promise<TransactionInstruction[]> {
    const ixs: TransactionInstruction[] = [];
    const assets = await fetchAllAssetV1(this.umi, mints);

    const collections = {};
    for (let i = 0; i < assets.length; i++) {
      const asset = assets[i];
      if (asset?.updateAuthority?.type !== "Collection") {
        throw new Error(
          "updateAuthority should be a collection for core assets"
        );
      } else if (!asset?.updateAuthority?.address) {
        throw new Error("missing updateAuthority address");
      }
      let collection;
      if (collections[asset.updateAuthority.address.toString()]) {
        collection = collections[asset.updateAuthority.address.toString()];
      } else {
        collection = await safeFetchCollectionV1(
          this.umi,
          asset.updateAuthority.address
        );
        if (!collection) {
          throw new Error(
            `Collection (${asset.updateAuthority.address.toString()}) not found for asset ${asset.publicKey.toString()}`
          );
        }
        collections[asset.updateAuthority.address.toString()] = collection;
      }
      await fetchCollectionV1(this.umi, asset.updateAuthority.address);
      ixs.push(
        ...updatePluginV1(this.umi, {
          asset: asset.publicKey,
          plugin: createPlugin({
            type: "PermanentFreezeDelegate",
            data: {
              frozen: false,
            },
          }),
          collection,
        })
          .getInstructions()
          .map((instruction) => toWeb3JsInstruction(instruction))
      );

      if (asset.owner.toString() != userPk.toString()) {
        // transfer delegate is automatically removed
        ixs.push(
          ...transferV1(this.umi, {
            asset: asset.publicKey,
            collection,
            newOwner: userPk,
          })
            .getInstructions()
            .map((instruction) => toWeb3JsInstruction(instruction))
        );
      } else {
        const transferIx = revokePluginAuthorityV1(this.umi, {
          asset: asset.publicKey,
          pluginType: PluginType.TransferDelegate,
          collection,
          // authority: createNoopSigner(userPk),
          authority: createNoopSigner(fromWeb3JsPublicKey(this.adminPk)),
        })
          .getInstructions()
          .map((instruction) => toWeb3JsInstruction(instruction));
        ixs.push(...transferIx);
      }
    }

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
