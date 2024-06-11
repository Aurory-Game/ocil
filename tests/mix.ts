import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import {
  MPL_TOKEN_METADATA_PROGRAM_ID,
  TokenStandard,
  createV1 as createV1TM,
  fetchAllDigitalAssetByOwner,
  fetchAllDigitalAssetWithTokenByOwner,
  findMasterEditionPda,
  mintV1,
  mplTokenMetadata,
  createMetadataAccountV3,
  createNft,
} from "@metaplex-foundation/mpl-token-metadata";

import {
  generateSigner,
  keypairIdentity,
  Umi,
  PublicKey as UmiPublicKey,
  sol,
  createSignerFromKeypair,
  Keypair as UmiKeypair,
  percentAmount,
  KeypairSigner,
} from "@metaplex-foundation/umi";
import * as anchor from "@coral-xyz/anchor";
import { Context } from "mocha";
import { AnchorProvider, Program, Provider, Wallet } from "@coral-xyz/anchor";
import { Casier } from "../target/types/casier";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  Signer,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  toWeb3JsPublicKey,
  fromWeb3JsPublicKey,
  toWeb3JsKeypair,
  toWeb3JsInstruction,
  fromWeb3JsInstruction,
} from "@metaplex-foundation/umi-web3js-adapters";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createMint,
  mintTo,
  createMintToInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { TxSender, createLookupTable, log } from "./utils";
import { LockerSDK } from "../package/index";
import {
  createCollection,
  mplCore,
  createV1,
  pluginAuthorityPair,
  ruleSet,
  fetchAllAssetV1,
  isFrozen,
} from "@metaplex-foundation/mpl-core";
import { assert } from "chai";
import { createNoopSigner } from "@metaplex-foundation/umi";
import idl from "../target/idl/casier.json";
anchor.setProvider(anchor.AnchorProvider.env());

// const program = anchor.workspace.Casier as Program<Casier>;
// const provider = program.provider as anchor.AnchorProvider;
// const providerPk = (program.provider as anchor.AnchorProvider).wallet.publicKey;
const mints = [];

// 2D array: users index, token accounts by mint index
const tokenAccounts: PublicKey[][] = [];
// 2D array: users, token account bumps by mint index
const tokenAccountBumps: number[][] = [];
// 2D array: user index, token accounts by mint index
const vaultTAs: PublicKey[][] = [];
// 2D array: user index, token account bumps by mint index
const vaultTABumps: number[][] = [];

interface CustomContext extends Context {
  umi: Umi;
  program: Program<Casier>;
  lookupTable: AddressLookupTableAccount;
  txSender: TxSender;
  lsdk: LockerSDK;
  usersAssets: UmiPublicKey[][];
  users: Keypair[];
  adminKeypair: null;
  oldAurorianAuth: KeypairSigner;
  coreAurorianAuth: KeypairSigner;
  coreAuroriansHolder: KeypairSigner;
  lockerProgramAdmin: KeypairSigner;
  connection: Connection;
  coreAurorianCollection: KeypairSigner;
  splAurorianCollection: KeypairSigner;
}

describe("Mix", function () {
  before(async function (this: CustomContext) {
    const connection = new Connection("http://127.0.0.1:8899", "recent");
    this.connection = connection;
    this.umi = createUmi(connection);
    const umi = this.umi;
    const adminKeypair = this.umi.eddsa.createKeypairFromSecretKey(
      ((anchor.getProvider() as anchor.AnchorProvider).wallet as anchor.Wallet)
        .payer.secretKey
    );
    this.oldAurorianAuth = generateSigner(this.umi);
    this.coreAurorianAuth = generateSigner(this.umi);
    this.coreAuroriansHolder = generateSigner(this.umi);
    this.lockerProgramAdmin = createSignerFromKeypair(this.umi, adminKeypair);
    this.coreAurorianCollection = generateSigner(this.umi);
    this.umi.use(mplCore()).use(mplTokenMetadata());
    // this.umi.use(keypairIdentity(this.oldAurorianAuth));
    this.umi.use(keypairIdentity(this.coreAurorianAuth));
    // this.umi.use(keypairIdentity(this.coreAuroriansHolder));
    // this.umi.use(keypairIdentity(this.lockerProgramAdmin));
    // this.umi.use(keypairIdentity(this.coreAurorianCollection));
    await this.umi.rpc.airdrop(this.oldAurorianAuth.publicKey, sol(100));
    await this.umi.rpc.airdrop(this.coreAurorianAuth.publicKey, sol(100));
    await this.umi.rpc.airdrop(this.coreAuroriansHolder.publicKey, sol(100));
    await this.umi.rpc.airdrop(this.lockerProgramAdmin.publicKey, sol(100));
    // await this.umi.rpc.airdrop(this.coreAurorianCollection.publicKey, sol(100));
    await createCollection(umi, {
      name: "Core Collection",
      uri: "https://example.com/collection.json",
      collection: this.coreAurorianCollection,
      updateAuthority: this.coreAurorianAuth.publicKey, // optional, defaults to payer
      plugins: [
        {
          type: "Royalties",
          basisPoints: 500,
          creators: [
            {
              address: this.coreAurorianAuth.publicKey,
              percentage: 100,
            },
          ],
          ruleSet: ruleSet("None"), // Compatibility rule set
        },
      ],
    }).sendAndConfirm(umi);

    this.users = await Promise.all(
      Array.from({ length: 2 }).map(async () => {
        const kp = Keypair.generate();
        await this.umi.rpc.airdrop(fromWeb3JsPublicKey(kp.publicKey), sol(100));
        return kp;
      })
    );

    this.mintCount = 2;
    this.usersAssets = [];
    let aurorianSequenceCounter = 1000;

    // mint core aurorians
    await Promise.all(
      this.users.map(async (user, i) => {
        this.usersAssets[i] = [];
        const promises = Array.from({ length: this.mintCount }).map(
          async (_, j) => {
            const asset = generateSigner(this.umi);
            this.usersAssets[i].push(asset.publicKey);

            return createV1(this.umi, {
              name: `Core Aurorian #${aurorianSequenceCounter++}`,
              uri: "https://example.com/asset.json",
              asset: asset,
              collection: this.coreAurorianCollection.publicKey,
              authority: createSignerFromKeypair(
                this.umi,
                this.coreAurorianAuth
              ),
              plugins: [
                pluginAuthorityPair({
                  type: "PermanentFreezeDelegate",
                  data: { frozen: false },
                }),
                pluginAuthorityPair({ type: "TransferDelegate" }),
              ],
              owner: fromWeb3JsPublicKey(user.publicKey),
            }).sendAndConfirm(this.umi);
          }
        );

        await Promise.all(promises);
      })
    );

    this.txSender = new TxSender(connection, false);
    this.program = new Program<Casier>(
      anchor.workspace.Casier.idl,
      anchor.workspace.Casier.programId,
      new AnchorProvider(
        this.connection,
        new Wallet(toWeb3JsKeypair(this.lockerProgramAdmin)),
        {
          commitment: "recent",
        }
      )
    );
    const [configPDA] = PublicKey.findProgramAddressSync(
      [anchor.utils.bytes.utf8.encode("config")],
      this.program.programId
    );

    const adminPk = toWeb3JsPublicKey(this.lockerProgramAdmin.publicKey);
    this.splAurorianCollection = generateSigner(umi);

    this.lsdk = new LockerSDK(
      connection,
      toWeb3JsPublicKey(this.lockerProgramAdmin.publicKey),
      this.program.programId,
      toWeb3JsPublicKey(this.coreAurorianAuth.publicKey),
      toWeb3JsPublicKey(this.oldAurorianAuth.publicKey),
      toWeb3JsPublicKey(this.splAurorianCollection.publicKey),
      this.coreAurorianCollection.publicKey,
      toWeb3JsPublicKey(this.coreAuroriansHolder.publicKey)
    );
    this.lookupTable = await createLookupTable(
      this.txSender,
      toWeb3JsKeypair(this.lockerProgramAdmin),
      [
        configPDA,
        adminPk,
        SystemProgram.programId,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
        SYSVAR_RENT_PUBKEY,
        SYSVAR_INSTRUCTIONS_PUBKEY,
        toWeb3JsPublicKey(MPL_TOKEN_METADATA_PROGRAM_ID),
      ]
    );

    let existingConfig;
    try {
      existingConfig = await this.program.account.config.fetch(configPDA);
    } catch (e) {}
    if (!existingConfig) {
      console.log(">> Initialize Config");
      await this.program.methods
        .initConfig()
        .accounts({
          config: configPDA,
          feePayer: this.lockerProgramAdmin.publicKey,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();
    }

    this.umi.use(keypairIdentity(this.oldAurorianAuth));
    await createNft(umi, {
      mint: this.splAurorianCollection,
      name: "Spl Aurorians collection",
      uri: "https://example.com/my-collection.json",
      sellerFeeBasisPoints: percentAmount(5.5), // 5.5%
      isCollection: true,
    }).sendAndConfirm(umi);
  });

  it("Prepare", async function (this: CustomContext) {
    const configPDA = this.configPDA;
    const users = this.users;
    // airdrops sols
    await Promise.all(
      users.map((user) =>
        this.connection.requestAirdrop(user.publicKey, 100 * 1e9)
      )
    );

    // create mints
    await Promise.all(
      [...Array(2).keys()]
        .map(() => Keypair.generate())
        .map((mint) => {
          mints.push(mint.publicKey);
          return createMint(
            this.connection,
            toWeb3JsKeypair(this.oldAurorianAuth),
            toWeb3JsPublicKey(this.oldAurorianAuth.publicKey),
            toWeb3JsPublicKey(this.oldAurorianAuth.publicKey),
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
              this.connection,
              toWeb3JsKeypair(this.oldAurorianAuth),
              mint,
              user.publicKey
            );
          })
        );
      })
    );

    // const a = await Promise.all(
    const ixs: TransactionInstruction[][] = mints.map((mint, mintIndex) => {
      let txBuilder = createV1TM(this.umi, {
        mint,
        authority: createNoopSigner(this.oldAurorianAuth.publicKey),
        name: `My NFT #${9000 + mintIndex}`,
        uri: `https://aurorians.cdn.aurory.io/aurorians-v2/current/metadata/${
          9000 + mintIndex
        }.json`,
        sellerFeeBasisPoints: percentAmount(5.5),
        tokenStandard: TokenStandard.Fungible,
        collection: {
          verified: false,
          key: this.splAurorianCollection.publicKey,
        },
      });
      const [editionPk] = findMasterEditionPda(this.umi, {
        mint: fromWeb3JsPublicKey(mint),
      });
      users
        .flatMap((user, userIndex) => {
          return mintV1(this.umi, {
            mint,
            authority: createNoopSigner(this.oldAurorianAuth.publicKey),
            amount: 10,
            tokenOwner: fromWeb3JsPublicKey(user.publicKey),
            // masterEdition: editionPk,
            tokenStandard: TokenStandard.Fungible,
          });
        })
        .forEach((tx) => (txBuilder = txBuilder.add(tx)));
      return txBuilder.getInstructions().map((ix) => toWeb3JsInstruction(ix));
    });
    // );
    await this.txSender.createAndSendV0Tx({
      txInstructions: ixs.flat(),
      payer: toWeb3JsPublicKey(this.oldAurorianAuth.publicKey),
      signers: [toWeb3JsKeypair(this.oldAurorianAuth)],
      lookupTableAccount: this.lookupTable,
      shouldLog: false,
    });

    // // initialize vault token accounts
    await Promise.all(
      users.map((user, index) =>
        mints.map(async (mint) => {
          const [ta, bump] = await PublicKey.findProgramAddress(
            [mint.toBuffer(), user.publicKey.toBuffer()],
            this.program.programId
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
  });

  it("Deposit", async function (this: CustomContext) {
    const userIndex = 0;
    const user = this.users[userIndex];

    const assets = this.usersAssets[userIndex];
    const depositCoreAmounts: Array<anchor.BN> = assets.map(
      (v, i) => new anchor.BN(1)
    );
    const depositMints = [].concat(
      ...assets.map((m) => toWeb3JsPublicKey(m)),
      ...mints
    );
    const depositStandardAmounts = mints.map((v, i) => new anchor.BN(i + 2));
    const depositAmounts = [].concat(
      ...depositCoreAmounts,
      ...depositStandardAmounts
    );
    const ixs = await this.lsdk.depositInstruction(
      depositMints,
      user.publicKey,
      depositAmounts
    );
    await this.txSender.createAndSendV0Tx({
      txInstructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 2_000_000 }),
        ...ixs,
      ],
      payer: user.publicKey,
      signers: [
        user,
        toWeb3JsKeypair(this.lockerProgramAdmin),
        toWeb3JsKeypair(this.coreAurorianAuth),
      ],
      lookupTableAccount: this.lookupTable,
      shouldLog: false,
    });
    const assetsFetched = await fetchAllAssetV1(this.umi, assets);
    for (let index = 0; index < assetsFetched.length; index++) {
      const asset = assetsFetched[index];
      assert.strictEqual(asset.owner.toString(), user.publicKey.toString());
      assert.isTrue(isFrozen(asset));
      // assert.strictEqual(
      //   asset.transferDelegate?.authority?.type,
      //   "UpdateAuthority"
      // );
    }
    for (let index = 0; index < mints.length; index++) {
      const mint = mints[index];
      const [burnTa, burnBump] = PublicKey.findProgramAddressSync(
        [mint.toBuffer()],
        this.program.programId
      );
      await this.connection.getParsedAccountInfo(burnTa);
      const burnAccount = await this.connection.getParsedAccountInfo(burnTa);
      const burnAmount = (
        burnAccount?.value?.data as any
      )?.parsed?.info?.tokenAmount?.uiAmount?.toString();
      assert.strictEqual(burnAmount, (index + 2).toString());
    }
  });

  it("Withdraw", async function (this: CustomContext) {
    const userIndex = 0;
    const user = this.users[userIndex];

    const assets = this.usersAssets[userIndex];
    const withdraw: Array<anchor.BN> = assets.map((v, i) => new anchor.BN(1));
    const withdrawMints = [].concat(
      ...assets.map((m) => toWeb3JsPublicKey(m)),
      ...mints
    );
    const withdrawStandardAmounts = mints.map((v, i) => new anchor.BN(i + 2));
    const withdrawAmounts = [].concat(...withdraw, ...withdrawStandardAmounts);
    const vaultOwners = mints.map(() => user.publicKey);
    const ixs = await this.lsdk.withdrawInstruction(
      withdrawMints,
      user.publicKey,
      vaultOwners,
      withdrawAmounts
    );
    await this.txSender.createAndSendV0Tx({
      txInstructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 2_000_000 }),
        ...ixs,
      ],
      payer: user.publicKey,
      signers: [
        user,
        toWeb3JsKeypair(this.lockerProgramAdmin),
        toWeb3JsKeypair(this.coreAurorianAuth),
      ],
      lookupTableAccount: this.lookupTable,
      shouldLog: false,
    });
    const assetsFetched = await fetchAllAssetV1(this.umi, assets);
    for (let index = 0; index < assetsFetched.length; index++) {
      const asset = assetsFetched[index];
      assert.strictEqual(asset.owner.toString(), user.publicKey.toString());
      assert.isFalse(isFrozen(asset));
      assert.strictEqual(asset.transferDelegate?.authority?.type, "Owner");
    }
    for (let index = 0; index < mints.length; index++) {
      const mint = mints[index];
      const [burnTa, burnBump] = PublicKey.findProgramAddressSync(
        [mint.toBuffer()],
        this.program.programId
      );
      await this.connection.getParsedAccountInfo(burnTa);
      const burnAccount = await this.connection.getParsedAccountInfo(burnTa);
      const burnAmount = (burnAccount?.value?.data as any)?.parsed?.info
        ?.tokenAmount?.uiAmount;
      assert.strictEqual(burnAmount, 0);
    }
  });
});
