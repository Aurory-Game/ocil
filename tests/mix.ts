import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { MPL_TOKEN_METADATA_PROGRAM_ID } from "@metaplex-foundation/mpl-token-metadata";

import {
  generateSigner,
  keypairIdentity,
  Umi,
  PublicKey as UmiPublicKey,
  sol,
  createSignerFromKeypair,
  Keypair as UmiKeypair,
} from "@metaplex-foundation/umi";
import * as anchor from "@coral-xyz/anchor";
import { Context } from "mocha";
import { Program } from "@coral-xyz/anchor";
import { Casier } from "../target/types/casier";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
} from "@solana/web3.js";
import {
  toWeb3JsPublicKey,
  fromWeb3JsPublicKey,
  toWeb3JsKeypair,
} from "@metaplex-foundation/umi-web3js-adapters";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createMint,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { TxSender, createLookupTable } from "./utils";
import { LockerSDK } from "../package/index";
import {
  createCollectionV1,
  mplCore,
  createV1,
  pluginAuthorityPair,
  ruleSet,
  fetchAllAssetV1,
  isFrozen,
} from "@metaplex-foundation/mpl-core";
import { assert } from "chai";

anchor.setProvider(anchor.AnchorProvider.env());

const program = anchor.workspace.Casier as Program<Casier>;
const provider = program.provider as anchor.AnchorProvider;
const providerPk = (program.provider as anchor.AnchorProvider).wallet.publicKey;
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
  adminKeypair: UmiKeypair;
  connection: Connection;
}

describe("Mix", function () {
  before(async function (this: CustomContext) {
    const connection = new Connection("http://127.0.0.1:8899", "recent");
    this.connection = connection;
    this.umi = createUmi(connection);
    this.adminKeypair = this.umi.eddsa.createKeypairFromSecretKey(
      ((anchor.getProvider() as anchor.AnchorProvider).wallet as anchor.Wallet)
        .payer.secretKey
    );
    this.umi.use(mplCore());
    this.umi.use(keypairIdentity(this.adminKeypair));
    await this.umi.rpc.airdrop(this.adminKeypair.publicKey, sol(100));
    const umi = this.umi;
    const collectionUpdateAuthority = this.adminKeypair;
    const collectionAddress = generateSigner(umi);
    await createCollectionV1(umi, {
      name: "Test Collection",
      uri: "https://example.com/collection.json",
      collection: collectionAddress,
      updateAuthority: collectionUpdateAuthority.publicKey, // optional, defaults to payer
      plugins: [
        pluginAuthorityPair({
          type: "PermanentFreezeDelegate",
          data: {
            frozen: false,
          },
        }),
        pluginAuthorityPair({
          type: "PermanentBurnDelegate",
        }),
        pluginAuthorityPair({
          type: "Royalties",
          data: {
            basisPoints: 500,
            creators: [
              {
                address: this.adminKeypair.publicKey,
                percentage: 100,
              },
            ],
            ruleSet: ruleSet("None"), // Compatibility rule set
          },
        }),
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
    await Promise.all(
      this.users.flatMap(async (user, i) => {
        this.usersAssets.push([]);
        Array.from({ length: this.mintCount }).map(async () => {
          const asset = generateSigner(this.umi);
          this.usersAssets[i].push(asset.publicKey);
          return createV1(umi, {
            name: "Test Asset",
            uri: "https://example.com/asset.json",
            asset: asset,
            collection: collectionAddress.publicKey,
            authority: createSignerFromKeypair(this.umi, this.adminKeypair),
            plugins: [
              pluginAuthorityPair({
                type: "PermanentFreezeDelegate",
                data: {
                  frozen: false,
                },
                // authority: pluginAuthority("Address", {
                //   address: this.adminKeypair.publicKey,
                // }),
              }),
              pluginAuthorityPair({
                type: "TransferDelegate",
              }),
            ],
            owner: fromWeb3JsPublicKey(user.publicKey),
          }).sendAndConfirm(umi);
        });
      })
    );

    this.txSender = new TxSender(connection, false);
    this.program = anchor.workspace.Casier;
    this.lsdk = new LockerSDK(
      connection,
      toWeb3JsPublicKey(this.adminKeypair.publicKey),
      this.program.programId,
      toWeb3JsPublicKey(this.adminKeypair.publicKey)
    );
    const [configPDA] = PublicKey.findProgramAddressSync(
      [anchor.utils.bytes.utf8.encode("config")],
      this.program.programId
    );

    const adminPk = toWeb3JsPublicKey(this.adminKeypair.publicKey);
    this.lookupTable = await createLookupTable(
      this.txSender,
      toWeb3JsKeypair(this.adminKeypair),
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
          feePayer: this.adminKeypair.publicKey,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();
    }
  });

  it("Prepare", async function (this: CustomContext) {
    const configPDA = this.configPDA;
    const users = this.users;
    // airdrops sols
    await Promise.all(
      users.map((user) =>
        provider.connection.requestAirdrop(user.publicKey, 100 * 1e9)
      )
    );

    // create mints
    await Promise.all(
      [...Array(2).keys()]
        .map(() => Keypair.generate())
        .map((mint) => {
          mints.push(mint.publicKey);
          return createMint(
            provider.connection,
            toWeb3JsKeypair(this.adminKeypair),
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
              toWeb3JsKeypair(this.adminKeypair),
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
              toWeb3JsKeypair(this.adminKeypair),
              mint,
              tokenAccounts[userIndex][mintIndex],
              toWeb3JsPublicKey(this.adminKeypair.publicKey),
              300
            )
          )
      )
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
      signers: [user, toWeb3JsKeypair(this.adminKeypair)],
      lookupTableAccount: this.lookupTable,
      shouldLog: false,
    });
    const assetsFetched = await fetchAllAssetV1(this.umi, assets);
    for (let index = 0; index < assetsFetched.length; index++) {
      const asset = assetsFetched[index];
      assert.strictEqual(asset.owner.toString(), user.publicKey.toString());
      assert.isTrue(isFrozen(asset));
    }
    for (let index = 0; index < mints.length; index++) {
      const mint = mints[index];
      const [burnTa, burnBump] = PublicKey.findProgramAddressSync(
        [mint.toBuffer()],
        program.programId
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
      signers: [user, toWeb3JsKeypair(this.adminKeypair)],
      lookupTableAccount: this.lookupTable,
      shouldLog: false,
    });
    const assetsFetched = await fetchAllAssetV1(this.umi, assets);
    for (let index = 0; index < assetsFetched.length; index++) {
      const asset = assetsFetched[index];
      assert.strictEqual(asset.owner.toString(), user.publicKey.toString());
      assert.isFalse(isFrozen(asset));
    }
    for (let index = 0; index < mints.length; index++) {
      const mint = mints[index];
      const [burnTa, burnBump] = PublicKey.findProgramAddressSync(
        [mint.toBuffer()],
        program.programId
      );
      await this.connection.getParsedAccountInfo(burnTa);
      const burnAccount = await this.connection.getParsedAccountInfo(burnTa);
      const burnAmount = (burnAccount?.value?.data as any)?.parsed?.info
        ?.tokenAmount?.uiAmount;
      assert.strictEqual(burnAmount, 0);
    }
  });
});
