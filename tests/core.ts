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

interface CustomContext extends Context {
  umi: Umi;
  program: Program<Casier>;
  lookupTable: AddressLookupTableAccount;
  txSender: TxSender;
  lsdk: LockerSDK;
  usersAssets: UmiPublicKey[][];
  users: Keypair[];
  admin: Keypair;
  adminKeypair: UmiKeypair;
}

describe("Core", function () {
  before(async function (this: CustomContext) {
    const connection = new Connection("http://127.0.0.1:8899", "recent");
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
        // pluginAuthorityPair({
        //   type: "PermanentTransferDelegate",
        // }),
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

  it("Deposit core nft", async function (this: CustomContext) {
    const userIndex = 0;
    const user = this.users[userIndex];

    const assets = this.usersAssets[userIndex];

    const depositAmounts: Array<anchor.BN> = assets.map(
      (v, i) => new anchor.BN(1)
    );
    const ixs = await this.lsdk.depositInstruction(
      assets.map((m) => toWeb3JsPublicKey(m)),
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
  });

  it("Withdraw core nft", async function (this: CustomContext) {
    const userIndex = 0;
    const user = this.users[userIndex];

    const assets = this.usersAssets[userIndex];

    const withdrawAmounts: Array<anchor.BN> = assets.map(
      (v, i) => new anchor.BN(1)
    );
    const vaultOwners = [];
    const ixs = await this.lsdk.withdrawInstruction(
      assets.map((m) => toWeb3JsPublicKey(m)),
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
  });

  it("Deposit, Transfer, Withdraw", async function (this: CustomContext) {
    const userIndex = 0;
    const user = this.users[userIndex];

    const assets = this.usersAssets[userIndex];

    const depositAmounts: Array<anchor.BN> = assets.map(
      (v, i) => new anchor.BN(1)
    );
    const destIndex = 1;
    const dest = this.users[destIndex];

    const withdrawAmounts: Array<anchor.BN> = assets.map(
      (v, i) => new anchor.BN(1)
    );
    const vaultOwners = [];

    const ixs = await this.lsdk.depositInstruction(
      assets.map((m) => toWeb3JsPublicKey(m)),
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
    const assetsFetched0 = await fetchAllAssetV1(this.umi, assets);
    for (let index = 0; index < assetsFetched0.length; index++) {
      const asset = assetsFetched0[index];
      assert.strictEqual(asset.owner.toString(), user.publicKey.toString());
      assert.strictEqual(
        asset.transferDelegate.authority.address,
        this.adminKeypair.publicKey
      );
      assert.isTrue(isFrozen(asset));
    }

    const ixs2 = await this.lsdk.withdrawInstruction(
      assets.map((m) => toWeb3JsPublicKey(m)),
      dest.publicKey,
      vaultOwners,
      withdrawAmounts
    );

    await this.txSender.createAndSendV0Tx({
      txInstructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 2_000_000 }),
        ...ixs2,
      ],
      payer: dest.publicKey,
      signers: [dest, toWeb3JsKeypair(this.adminKeypair)],
      lookupTableAccount: this.lookupTable,
      shouldLog: false,
    });
    const assetsFetched = await fetchAllAssetV1(this.umi, assets);
    for (let index = 0; index < assetsFetched.length; index++) {
      const asset = assetsFetched[index];
      assert.strictEqual(asset.transferDelegate.authority.type, "Owner");
      assert.strictEqual(asset.owner.toString(), dest.publicKey.toString());
      assert.isFalse(isFrozen(asset));
    }
  });

  it("Deposit, Withdraw from a different user", async function (this: CustomContext) {
    const sourceIndex = 1;
    const destIndex = 0;
    const user = this.users[sourceIndex];
    const dest = this.users[destIndex];

    const assets = this.usersAssets[destIndex]; // as we have transferred them to user 1 in the previous test
    const depositAmounts: Array<anchor.BN> = assets.map(
      (v, i) => new anchor.BN(1)
    );
    const withdrawAmounts: Array<anchor.BN> = assets.map(
      (v, i) => new anchor.BN(1)
    );
    const vaultOwners = [];

    const ixs = await this.lsdk.depositInstruction(
      assets.map((m) => toWeb3JsPublicKey(m)),
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
    const ixs2 = await this.lsdk.withdrawInstruction(
      assets.map((m) => toWeb3JsPublicKey(m)),
      dest.publicKey,
      vaultOwners,
      withdrawAmounts
    );
    await this.txSender.createAndSendV0Tx({
      txInstructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 2_000_000 }),
        ...ixs2,
      ],
      payer: dest.publicKey,
      signers: [dest, toWeb3JsKeypair(this.adminKeypair)],
      lookupTableAccount: this.lookupTable,
      shouldLog: false,
    });
    const assetsFetched = await fetchAllAssetV1(this.umi, assets);
    for (let index = 0; index < assetsFetched.length; index++) {
      const asset = assetsFetched[index];
      assert.strictEqual(asset.owner.toString(), dest.publicKey.toString());
      assert.isFalse(isFrozen(asset));
    }
  });
});
