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
  publicKey,
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
  toWeb3JsInstruction,
} from "@metaplex-foundation/umi-web3js-adapters";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { TxSender, createLookupTable, log } from "./utils";
import { LockerSDK } from "../package/index";
import {
  createCollectionV1,
  mplCore,
  createV1,
  pluginAuthorityPair,
  ruleSet,
  fetchAllAssetV1,
  isFrozen,
  create,
  fetchAsset,
  transfer,
} from "@metaplex-foundation/mpl-core";
import { assert } from "chai";
import { createNoopSigner } from "@metaplex-foundation/umi";
import { fromWeb3JsKeypair } from "@metaplex-foundation/umi-web3js-adapters";

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
  collectionAddress: UmiPublicKey;
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
    this.collectionAddress = collectionAddress.publicKey;
    await createCollectionV1(umi, {
      name: "Test Collection",
      uri: "https://example.com/collection.json",
      collection: collectionAddress,
      updateAuthority: this.adminKeypair.publicKey,
    }).sendAndConfirm(umi);

    this.users = await Promise.all(
      Array.from({ length: 2 }).map(async () => {
        const kp = Keypair.generate();
        await this.umi.rpc.airdrop(fromWeb3JsPublicKey(kp.publicKey), sol(100));
        return kp;
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
  });

  it("transfer delegate", async function (this: CustomContext) {
    const userIndex = 0;
    const user = this.users[userIndex];

    const asset = generateSigner(this.umi);

    const tb = create(this.umi, {
      asset,
      collection: { publicKey: this.collectionAddress },
      name: ".",
      uri: ".",
      plugins: [
        {
          type: "TransferDelegate",
          authority: {
            type: "UpdateAuthority",
          },
        },
      ],
      authority: createNoopSigner(this.adminKeypair.publicKey),
      owner: publicKey(user.publicKey),
      payer: createNoopSigner(publicKey(user.publicKey)),
    });

    const ixs = tb.getInstructions().map((ix) => toWeb3JsInstruction(ix));
    log(
      new Set(
        ixs.map((ix) =>
          ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toString())
        )
      )
    );
    await this.txSender.createAndSendV0Tx({
      txInstructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 2_000_000 }),
        ...ixs,
      ],
      payer: user.publicKey,
      signers: [
        user,
        toWeb3JsKeypair(asset),
        toWeb3JsKeypair(this.adminKeypair),
      ],
      // lookupTableAccount: this.lookupTable,
      shouldLog: false,
    });
    const fa = await fetchAsset(this.umi, asset.publicKey);
    log(fa);
    const dest = this.users[1];
    const tb2 = transfer(this.umi, {
      asset: { publicKey: asset.publicKey, owner: publicKey(dest.publicKey) },
      collection: { publicKey: this.collectionAddress },
      authority: createNoopSigner(this.adminKeypair.publicKey),
      payer: createNoopSigner(publicKey(dest.publicKey)),
      newOwner: publicKey(dest.publicKey),
    });

    const ixs2 = tb2.getInstructions().map((ix) => toWeb3JsInstruction(ix));
    log(
      new Set(
        ixs2.map((ix) =>
          ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toString())
        )
      )
    );
    await this.txSender.createAndSendV0Tx({
      txInstructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 2_000_000 }),
        ...ixs2,
      ],
      payer: user.publicKey,
      signers: [dest, user, toWeb3JsKeypair(this.adminKeypair)],
      // lookupTableAccount: this.lookupTable,
      shouldLog: true,
    });

    // const assetsFetched = await fetchAllAssetV1(this.umi, assets);
    // for (let index = 0; index < assetsFetched.length; index++) {
    //   const asset = assetsFetched[index];
    //   assert.strictEqual(asset.owner.toString(), user.publicKey.toString());
    //   assert.isTrue(isFrozen(asset));
    // }
  });
});
