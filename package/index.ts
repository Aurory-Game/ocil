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
  Metadata,
  updateV1,
  unverifyCollectionV1,
  unverifyCreatorV1,
  transferV1 as transferV1TM,
} from "@metaplex-foundation/mpl-token-metadata";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import {
  Umi,
  MaybeRpcAccount,
  PublicKey as UmiPublicKey,
  unwrapOption,
  signerIdentity,
  createNoopSigner,
  publicKey,
} from "@metaplex-foundation/umi";
import { Casier } from "../target/types/casier";
import idl from "../target/idl/casier.json";
import {
  MPL_CORE_PROGRAM_ID,
  fetchAllAssetV1,
  fetchCollectionV1,
  safeFetchCollectionV1,
  transfer,
  updatePluginV1,
  updatePlugin,
  createPlugin,
  addressPluginAuthority,
  PluginType,
  revokePluginAuthority,
  approvePluginAuthority,
  fetchAssetV1,
  fetchAsset,
  addPlugin,
} from "@metaplex-foundation/mpl-core";
import { log } from "../tests/utils";
import * as fs from "fs";

export class LockerSDK {
  umi: Umi;
  program: anchor.Program<Casier>;
  adminPk: PublicKey;
  configPDA: PublicKey;
  lockerPDA: PublicKey;
  connection: Connection;
  coreAssetsAuthority: anchor.web3.PublicKey;
  splAurorianAuthority: anchor.web3.PublicKey;
  oldMintToSeq: Record<string, number>;
  seqToNewMint: Record<number, string>;
  splAurorianCollection: anchor.web3.PublicKey;
  coreAurorianCollection: string;
  coreAuroriansHolder: string | anchor.web3.PublicKey;
  constructor(
    connection: Connection,
    adminPk: PublicKey,
    programId: PublicKey,
    coreAssetsAuthority?: PublicKey,
    splAurorianAuthority?: PublicKey,
    splAurorianCollection?: PublicKey,
    coreAurorianCollection?: string,
    coreAuroriansHolder?: PublicKey,
    oldMintToSeq?: Record<string, number>,
    seqToNewMint?: Record<number, string>
  ) {
    this.connection = connection;
    this.umi = createUmi(connection);
    // this.umi.use(
    //   signerIdentity(createNoopSigner(fromWeb3JsPublicKey(adminPk)))
    // );
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
    this.coreAssetsAuthority = coreAssetsAuthority ?? adminPk;
    this.splAurorianAuthority = splAurorianAuthority ?? adminPk;
    this.splAurorianCollection = splAurorianCollection;
    this.coreAurorianCollection = coreAurorianCollection;
    this.coreAuroriansHolder = coreAuroriansHolder ?? this.coreAssetsAuthority;
    this.oldMintToSeq =
      oldMintToSeq ??
      JSON.parse(
        fs.readFileSync(__dirname + "/old-mint-to-seq.json").toString()
      );
    this.seqToNewMint =
      seqToNewMint ??
      JSON.parse(fs.readFileSync(__dirname + "/seq-to-mint.json").toString());
  }

  public async getCoreAmount(
    asset: PublicKey,
    owner: PublicKey
  ): Promise<string> {
    try {
      const fetchedAsset = await fetchAssetV1(
        this.umi,
        fromWeb3JsPublicKey(asset)
      );
      return fetchedAsset?.permanentFreezeDelegate?.frozen ? "1" : "0";
    } catch (e) {
      return "0";
    }
  }

  /**
   * Put assets and amounts in order: core, pnft, spl
   * */
  public async orderMints(
    mints: PublicKey[],
    unorderedAmounts: anchor.BN[],
    sameTxMintCreation?: PublicKey[]
  ): Promise<{
    orderedMints: PublicKey[];
    pnftCount: number;
    coreNftCount: number;
    orderedAmounts: anchor.BN[];
    nonCoreMetadata: { metadata: Metadata }[];
  }> {
    const accountInfoArr = await Promise.all(
      mints.map(async (mint) => {
        return this.connection.getAccountInfo(mint);
      })
    );
    const orderedMintsWithoutCore: PublicKey[] = [];
    const coreAssets = [];
    const orderedAmounts: anchor.BN[] = [];
    const nonCoreAmounts: anchor.BN[] = [];
    const nonCoreMetadata: { metadata: Metadata }[] = [];
    let pnftCount = 0;
    for (let i = 0; i < accountInfoArr.length; i++) {
      const mint = mints[i];
      const amount = unorderedAmounts[i];
      const accountInfo = accountInfoArr[i];
      if (accountInfo) {
        const programId = accountInfo.owner;
        if (programId.equals(toWeb3JsPublicKey(MPL_CORE_PROGRAM_ID))) {
          coreAssets.push(mint);
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
            nonCoreMetadata.push({ metadata });
          }
        }
      }
    }

    orderedAmounts.push(...nonCoreAmounts);
    const orderedMints = coreAssets.concat(orderedMintsWithoutCore);

    if (sameTxMintCreation?.length) {
      for (let i = 0; i < sameTxMintCreation.length; i++) {
        const mint = sameTxMintCreation[i];
        const index = mints.findIndex((m2) => mint.equals(m2));
        if (index === -1)
          throw new Error(
            "Mints created in the same tx should be included in the mint list."
          );
        orderedAmounts.push(unorderedAmounts[index]);
      }
      orderedMints.push(...sameTxMintCreation);
    }
    if (orderedMints.length !== mints.length) {
      throw new Error("mints and orderedMints length mismatch");
    }
    return {
      orderedMints,
      pnftCount,
      coreNftCount: coreAssets.length,
      orderedAmounts,
      nonCoreMetadata,
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
      // await fetchCollectionV1(this.umi, asset.updateAuthority.address);
      this.umi.use(
        signerIdentity(createNoopSigner(publicKey(this.coreAssetsAuthority)))
      );
      const freezeIxBuilder = updatePlugin(this.umi, {
        asset: asset.publicKey,
        plugin: {
          type: "PermanentFreezeDelegate",
          frozen: true,
        },
        authority: createNoopSigner(publicKey(this.coreAssetsAuthority)),
        collection,
        payer: createNoopSigner(owner),
      });

      const freezeIx = freezeIxBuilder
        .getInstructions()
        .map((instruction) => toWeb3JsInstruction(instruction));
      ixs.push(...freezeIx);
      if (asset.transferDelegate) {
        const transferIx = approvePluginAuthority(this.umi, {
          asset: asset.publicKey,
          collection,
          plugin: {
            type: "TransferDelegate",
          },
          authority: createNoopSigner(owner),
          // newAuthority: {
          //   type: "UpdateAuthority",
          // },
          newAuthority: {
            type: "Address",
            address: fromWeb3JsPublicKey(this.coreAssetsAuthority),
          },
        })
          .getInstructions()
          .map((instruction) => toWeb3JsInstruction(instruction));
        ixs.push(...transferIx);
      } else {
        const transferIx = addPlugin(this.umi, {
          asset: asset.publicKey,
          collection,
          plugin: {
            type: "TransferDelegate",
            authority: {
              type: "Address",
              address: fromWeb3JsPublicKey(this.coreAssetsAuthority),
            },
          },
          authority: createNoopSigner(owner),
        })
          .getInstructions()
          .map((instruction) => toWeb3JsInstruction(instruction));
        ixs.push(...transferIx);
      }
    }
    return ixs;
  }

  async depositCoreInstructionWrapper(
    orderedMints: PublicKey[],
    coreNftCount: number,
    userPk: PublicKey,
    nonce: anchor.BN,
    lockerPDA: PublicKey
  ): Promise<TransactionInstruction[]> {
    const ixs: TransactionInstruction[] = [];
    const coreIxs = await this.depositCoreInstruction(
      orderedMints.slice(0, coreNftCount).map((m) => fromWeb3JsPublicKey(m)),
      fromWeb3JsPublicKey(userPk)
    );
    const onlyCore = coreNftCount === orderedMints.length;
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
      coreNftCount,
      orderedAmounts: depositAmounts,
      nonCoreMetadata,
    } = await this.orderMints(unorderedMints, unorderedDepositAmounts);

    const [lockerPDA] = PublicKey.findProgramAddressSync(
      [userPk.toBuffer()],
      this.program.programId
    );
    const lockerInitIx = await this.initLockerInstructionIfNeeded(
      userPk,
      lockerPDA
    );
    let nonce = new anchor.BN(0);
    const ixs: TransactionInstruction[] = [];

    if (lockerInitIx) {
      ixs.push(lockerInitIx);
    } else {
      const locker = await this.program.account.locker.fetch(lockerPDA);
      nonce = locker.space;
    }

    if (
      orderedMints.length === 1 &&
      nonCoreMetadata.length === 1 &&
      this.isSplAurorian(nonCoreMetadata[0])
    ) {
      const { ixs: unverifyOldAndTransferNewIx } =
        await this.unverifyOldAndTransferNewAurorian(
          nonCoreMetadata[0],
          userPk,
          nonce,
          lockerPDA
        );
      ixs.push(...unverifyOldAndTransferNewIx);
      return ixs;
    }

    if (coreNftCount > 0) {
      const coreIxs = await this.depositCoreInstructionWrapper(
        orderedMints,
        coreNftCount,
        userPk,
        nonce,
        lockerPDA
      );
      ixs.push(...coreIxs);
    }

    if (orderedMints.length > coreNftCount) {
      const standardAndPnftIxs = await this.depositStandardAndPnftInstruction(
        orderedMints.slice(coreNftCount),
        pnftCount,
        userPk,
        depositAmounts.slice(coreNftCount),
        nonce,
        lockerPDA
      );
      ixs.push(...standardAndPnftIxs);
    }
    return ixs;
  }
  async unverifyOldAndTransferNewAurorian(
    nonCoreMetadata: { metadata: Metadata },
    userPk: anchor.web3.PublicKey,
    nonce: anchor.BN,
    lockerPDA: PublicKey
  ): Promise<{ ixs: anchor.web3.TransactionInstruction[]; newMint: string }> {
    const ixs: anchor.web3.TransactionInstruction[] = [];
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

    const metadata = nonCoreMetadata.metadata;
    const mint = metadata.mint;
    const sequence = this.oldMintToSeq[mint.toString()];
    const newMint = this.seqToNewMint[sequence];
    const masterEdition = findMasterEditionPda(this.umi, {
      mint: publicKey(mint),
    });
    const fetchedAsset = await fetchAssetV1(this.umi, publicKey(newMint));
    this.umi.use(signerIdentity(createNoopSigner(publicKey(userPk))));
    const txBuilder = transferV1TM(this.umi, {
      mint: publicKey(mint),
      destinationOwner: publicKey(this.coreAssetsAuthority),
      payer: createNoopSigner(publicKey(userPk)),
      authority: createNoopSigner(publicKey(userPk)),
      edition: masterEdition,
      tokenStandard: TokenStandard.NonFungibleEdition,
    })
      .add(
        transfer(this.umi, {
          asset: {
            publicKey: publicKey(newMint),
            owner: publicKey(this.coreAuroriansHolder),
          },
          payer: createNoopSigner(publicKey(userPk)),
          newOwner: publicKey(userPk),
          collection: { publicKey: publicKey(this.coreAurorianCollection) },
          authority: createNoopSigner(publicKey(this.coreAuroriansHolder)),
        })
      )
      .add(
        updatePlugin(this.umi, {
          asset: publicKey(newMint),
          plugin: {
            type: "PermanentFreezeDelegate",
            frozen: true,
          },
          authority: createNoopSigner(publicKey(this.coreAssetsAuthority)),
          collection: publicKey(this.coreAurorianCollection),
          payer: createNoopSigner(publicKey(userPk)),
        })
      )
      .add(
        approvePluginAuthority(this.umi, {
          asset: publicKey(newMint),
          collection: publicKey(this.coreAurorianCollection),
          plugin: {
            type: "TransferDelegate",
          },
          authority: createNoopSigner(publicKey(userPk)),
          // newAuthority: {
          //   type: "UpdateAuthority",
          // },
          newAuthority: {
            type: "Address",
            address: fromWeb3JsPublicKey(this.coreAssetsAuthority),
          },
        })
      );
    ixs.push(
      ...txBuilder.getInstructions().map((ix) => toWeb3JsInstruction(ix))
    );

    return { ixs, newMint };
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

  isSplAurorian({ metadata }: { metadata: Metadata }) {
    const regex = /^(Aurorian|Helios) #\d+$/;
    const name = metadata?.name;
    if (name && regex.test(name)) {
      return true;
    }
    return false;
  }

  /**
   * 
   * @param unorderedMints 
   * @param userPk 
   * @param vaultOwners 
   * @param unorderedWithdrawAmounts 
   * @param sameTxMintCreation If some mints are created in the same tx, they should be included here on top of unorderedMints.
      Mint creation txs should be included before the ixs returned by this function.
   * @returns 
   */
  async withdrawInstruction(
    unorderedMints: PublicKey[],
    userPk: PublicKey,
    vaultOwners: PublicKey[],
    unorderedWithdrawAmounts: anchor.BN[],
    sameTxMintCreation?: PublicKey[]
  ): Promise<TransactionInstruction[]> {
    const {
      orderedMints,
      pnftCount,
      coreNftCount,
      orderedAmounts: withdrawAmounts,
    } = await this.orderMints(
      unorderedMints,
      unorderedWithdrawAmounts,
      sameTxMintCreation
    );

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

    if (coreNftCount > 0) {
      const coreIxs = await this.withdrawCoreInstruction(
        orderedMints.slice(0, coreNftCount).map((m) => fromWeb3JsPublicKey(m)),
        fromWeb3JsPublicKey(userPk)
      );
      const onlyCore = coreNftCount === orderedMints.length;
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
      orderedMints.slice(coreNftCount),
      pnftCount,
      userPk,
      withdrawAmounts.slice(coreNftCount),
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
    withdrawAmounts: anchor.BN[],
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
      remainingAccounts.push(
        {
          pubkey: vaultTa,
          isWritable: true,
          isSigner: false,
        },
        {
          pubkey: vaultOwner,
          isWritable: true,
          isSigner: false,
        },
        {
          pubkey: burnTa,
          isWritable: true,
          isSigner: false,
        }
      );
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
      // await fetchCollectionV1(this.umi, asset.updateAuthority.address);

      ixs.push(
        ...updatePlugin(this.umi, {
          asset: asset.publicKey,
          plugin: {
            type: "PermanentFreezeDelegate",
            frozen: false,
          },
          collection,
          payer: createNoopSigner(userPk),
          authority: createNoopSigner(publicKey(this.coreAssetsAuthority)),
        })
          .getInstructions()
          .map((instruction) => toWeb3JsInstruction(instruction))
      );
      const assetsFetched0 = await fetchAsset(this.umi, asset.publicKey);

      if (asset.owner.toString() !== userPk.toString()) {
        // transfer delegate is automatically removed
        ixs.push(
          ...transfer(this.umi, {
            asset: asset,
            collection,
            newOwner: userPk,
            payer: createNoopSigner(userPk),
            authority: createNoopSigner(
              fromWeb3JsPublicKey(this.coreAssetsAuthority)
            ),
          })
            .getInstructions()
            .map((instruction) => toWeb3JsInstruction(instruction))
        );
      } else {
        const transferIx = revokePluginAuthority(this.umi, {
          asset: asset.publicKey,
          // pluginType: PluginType.TransferDelegate,
          plugin: {
            type: "TransferDelegate",
          },
          collection,
          payer: createNoopSigner(userPk),
          authority: createNoopSigner(userPk),
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
