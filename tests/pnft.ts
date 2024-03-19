import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import {
  MPL_TOKEN_METADATA_PROGRAM_ID,
  createProgrammableNft,
  mplTokenMetadata,
  findMetadataPda,
  findTokenRecordPda,
  fetchEdition,
  findMasterEditionPda,
  createAndMint,
  TokenStandard,
  createV1,
  mintV1,
} from "@metaplex-foundation/mpl-token-metadata";
import {
  generateSigner,
  percentAmount,
  keypairIdentity,
  Umi,
  PublicKey as UmiPublicKey,
  sol,
  transactionBuilder,
  signerIdentity,
  publicKey,
  Signer as UmiSigner,
  createSignerFromKeypair,
  Keypair as UmiKeypair,
} from "@metaplex-foundation/umi";
import * as anchor from "@coral-xyz/anchor";
import { Context } from "mocha";
import { Program } from "@coral-xyz/anchor";
import { Casier } from "../target/types/casier";
import {
  AccountMeta,
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  Signer,
} from "@solana/web3.js";
import {
  toWeb3JsPublicKey,
  fromWeb3JsPublicKey,
  toWeb3JsKeypair,
} from "@metaplex-foundation/umi-web3js-adapters";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { TxSender, createLookupTable } from "./utils";
import { LockerSDK } from "../package/index";

anchor.setProvider(anchor.AnchorProvider.env());

interface CustomContext extends Context {
  umi: Umi;
  program: Program<Casier>;
  lookupTable: AddressLookupTableAccount;
  txSender: TxSender;
  lsdk: LockerSDK;
  pnftMints: UmiPublicKey[];
  users: Keypair[];
  admin: Keypair;
  adminKeypair: UmiKeypair;
}

describe("pnft", function () {
  before(async function (this: CustomContext) {
    console.log("> Preparation");
    console.log(">> Mint pNFT");
    const connection = new Connection("http://127.0.0.1:8899", "recent");
    this.umi = createUmi(connection);
    this.adminKeypair = this.umi.eddsa.createKeypairFromSecretKey(
      ((anchor.getProvider() as anchor.AnchorProvider).wallet as anchor.Wallet)
        .payer.secretKey
    );
    this.umi.use(mplTokenMetadata());
    this.umi.use(keypairIdentity(this.adminKeypair));
    // this.signer = {
    //   publicKey: this.admin.publicKey,
    //   secretKey: this.admin.secretKey,
    // } as Signer;

    await this.umi.rpc.airdrop(this.adminKeypair.publicKey, sol(100));
    this.users = await Promise.all(
      Array.from({ length: 1 }).map(async () => {
        const kp = Keypair.generate();
        await this.umi.rpc.airdrop(fromWeb3JsPublicKey(kp.publicKey), sol(100));
        return kp;
      })
    );
    this.program = anchor.workspace.Casier;
    this.lsdk = new LockerSDK(
      connection,
      toWeb3JsPublicKey(this.adminKeypair.publicKey),
      this.program.programId
    );
    this.pnftMints = await Promise.all(
      Array.from({ length: 2 }).map(async (v, i) => {
        const mint = generateSigner(this.umi);
        console.log("mint", mint.publicKey);
        const user = this.users[i % this.users.length];
        const userTa = getAssociatedTokenAddressSync(
          toWeb3JsPublicKey(mint.publicKey),
          user.publicKey
        );
        const [tokenRecordSender] = findTokenRecordPda(this.umi, {
          mint: mint.publicKey,
          token: fromWeb3JsPublicKey(userTa),
        });
        console.log(tokenRecordSender);

        const ind = await createProgrammableNft(this.umi, {
          name: "My NFT",
          uri: "https://example.com/my-nft.json",
          authority: createSignerFromKeypair(this.umi, this.adminKeypair),
          sellerFeeBasisPoints: percentAmount(5.5),
          creators: [
            {
              address: this.adminKeypair.publicKey,
              verified: true,
              share: 100,
            },
          ],
          mint,
          tokenOwner: fromWeb3JsPublicKey(user.publicKey),
          // token: fromWeb3JsPublicKey(userTa),
          // tokenRecord: tokenRecordSender,
        }).sendAndConfirm(this.umi);
        console.log(
          await connection.getParsedAccountInfo(
            toWeb3JsPublicKey(tokenRecordSender)
          )
        );
        return mint.publicKey;
      })
    );
    this.txSender = new TxSender(connection, false);

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

  it("Deposit pNFT", async function (this: CustomContext) {
    const user = this.users[0];
    const mints: Array<PublicKey> = this.pnftMints.map((m) =>
      toWeb3JsPublicKey(m)
    );

    const depositAmounts: Array<anchor.BN> = mints.map(
      (v, i) => new anchor.BN(1)
    );
    const ixs = await this.lsdk.depositInstruction(
      mints,
      user.publicKey,
      depositAmounts
    );
    console.log("here");
    await this.txSender.createAndSendV0Tx({
      txInstructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 2_000_000 }),
        ...ixs,
      ],
      payer: user.publicKey,
      signers: [user, toWeb3JsKeypair(this.adminKeypair)],
      lookupTableAccount: this.lookupTable,
      shouldLog: true,
    });
    // const vaultAccount = await this.connection.getParsedAccountInfo(
    //   remainingAccounts[5].pubkey
    // );
    // console.log(remainingAccounts[5].pubkey.toString());
    // console.log(vaultAccount.value.data?.parsed);
    // const lockerAccount = await this.program.account.locker.fetch(
    //   this.lockerPDA
    // );
    // console.log(lockerAccount);
  });

  it("Withdraw pNFT", async function (this: CustomContext) {
    const user = this.users[0];
    const mints: Array<PublicKey> = this.pnftMints.map((m) =>
      toWeb3JsPublicKey(m)
    );
    const withdrawAmounts = mints.map((v, i) => new anchor.BN(1));
    const finalAmounts = mints.map((v, i) => new anchor.BN(0));
    const userPk = user.publicKey;
    const vaultOwner = user.publicKey;
    const ixs = await this.lsdk.withdrawInstruction(
      mints,
      userPk,
      vaultOwner,
      withdrawAmounts,
      finalAmounts
    );

    await this.txSender.createAndSendV0Tx({
      txInstructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 2_000_000 }),
        ...ixs,
      ],
      payer: userPk,
      signers: [user, toWeb3JsKeypair(this.adminKeypair)],
      lookupTableAccount: this.lookupTable,
    });
  });
});
