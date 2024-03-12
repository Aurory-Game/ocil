import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import {
  MPL_TOKEN_METADATA_PROGRAM_ID,
  createProgrammableNft,
  mplTokenMetadata,
  findMetadataPda,
  findTokenRecordPda,
  fetchEdition,
  findMasterEditionPda,
} from "@metaplex-foundation/mpl-token-metadata";
import {
  generateSigner,
  percentAmount,
  keypairIdentity,
  Umi,
  PublicKey as UmiPublicKey,
  sol,
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
  Signer,
  SystemProgram,
} from "@solana/web3.js";
import {
  toWeb3JsPublicKey,
  fromWeb3JsPublicKey,
} from "@metaplex-foundation/umi-web3js-adapters";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { TxSender, createLookupTable } from "./utils";

anchor.setProvider(anchor.AnchorProvider.env());

interface CustomContext extends Context {
  umi: Umi;
  pnftMint: UmiPublicKey;
  program: Program<Casier>;
  adminPk: PublicKey;
  configPDA: PublicKey;
  payer: Keypair;
  signer: Signer;
  lookupTable: AddressLookupTableAccount;
  txSender: TxSender;
  connection: Connection;
  lockerPDA: PublicKey;
  editionPk: PublicKey;
}

describe("pnft", function () {
  before(async function (this: CustomContext) {
    console.log("> Preparation");
    console.log(">> Mint pNFT");
    console.log(anchor.getProvider().connection.rpcEndpoint);
    this.umi = createUmi(anchor.getProvider().connection.rpcEndpoint);
    this.payer = (
      (anchor.getProvider() as anchor.AnchorProvider).wallet as anchor.Wallet
    ).payer;
    this.signer = {
      publicKey: this.payer.publicKey,
      secretKey: this.payer.secretKey,
    } as Signer;
    const adminKeypair = this.umi.eddsa.createKeypairFromSecretKey(
      ((anchor.getProvider() as anchor.AnchorProvider).wallet as anchor.Wallet)
        .payer.secretKey
    );
    this.adminPk = toWeb3JsPublicKey(adminKeypair.publicKey);
    await this.umi.rpc.airdrop(adminKeypair.publicKey, sol(100));
    this.connection = anchor.getProvider().connection;

    this.umi.use(keypairIdentity(adminKeypair)).use(mplTokenMetadata());

    const pnftMint = generateSigner(this.umi);

    const i = await createProgrammableNft(this.umi, {
      mint: pnftMint,
      name: "My NFT",
      uri: "https://example.com/my-nft.json",
      sellerFeeBasisPoints: percentAmount(5.5),
      creators: [
        {
          address: adminKeypair.publicKey,
          verified: true,
          share: 100,
        },
      ],
    }).sendAndConfirm(this.umi);

    this.pnftMint = pnftMint.publicKey;
    this.program = anchor.workspace.Casier;

    console.log(">> Initialize Casier");
    await this.program.methods.initialize().rpc();

    console.log(">> Initialize Config");
    const [configPDA] = PublicKey.findProgramAddressSync(
      [anchor.utils.bytes.utf8.encode("config")],
      this.program.programId
    );
    this.configPDA = configPDA;
    await this.program.methods
      .initConfig()
      .accounts({
        config: configPDA,
        feePayer: adminKeypair.publicKey,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();
    this.txSender = new TxSender(this.connection, true);

    this.lookupTable = await createLookupTable(this.txSender, this.payer, [
      configPDA,
      this.adminPk,
      SystemProgram.programId,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
      SYSVAR_RENT_PUBKEY,
      SYSVAR_INSTRUCTIONS_PUBKEY,
      toWeb3JsPublicKey(MPL_TOKEN_METADATA_PROGRAM_ID),
    ]);

    const space = new anchor.BN(500);
    const [lockerPDA] = PublicKey.findProgramAddressSync(
      [this.adminPk.toBytes()],
      this.program.programId
    );
    this.lockerPDA = lockerPDA;
    await this.program.methods
      .initLocker(space)
      .accounts({
        locker: this.lockerPDA,
        owner: this.adminPk,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([this.signer])
      .rpc();
  });

  it("Prepare", async function (this: CustomContext) {
    const mints: Array<PublicKey> = [this.pnftMint].map((m) =>
      toWeb3JsPublicKey(m)
    );
    const depositAmounts: Array<anchor.BN> = mints.map(
      (v, i) => new anchor.BN(1)
    );
    const beforeAmounts: Array<anchor.BN> = mints.map(
      (v, i) => new anchor.BN(0)
    );
    const remainingAccounts: Array<AccountMeta> = [];
    const vaultBumps: Array<number> = [];
    const burnBumps: Array<number> = [];
    const userPk = this.adminPk;
    const pnftCount = 1;
    for (let index = 0; index < mints.length; index++) {
      if (index < pnftCount) {
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
        mint: this.pnftMint,
      });
      remainingAccounts.push({
        pubkey: toWeb3JsPublicKey(editionPk),
        isWritable: false,
        isSigner: false,
      });
    }

    const lockerPDA = this.lockerPDA;

    const ix = await this.program.methods
      .depositBatch(
        depositAmounts,
        beforeAmounts,
        Buffer.from(vaultBumps),
        Buffer.from(burnBumps),
        false, // set to 'true' if you want to go to burn TA, otherwise 'false'
        pnftCount
      )
      .accounts({
        config: this.configPDA,
        locker: lockerPDA,
        admin: userPk,
        owner: userPk,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .remainingAccounts(remainingAccounts)
      .instruction();

    await this.txSender.createAndSendV0Tx({
      txInstructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 2_000_000 }),
        ix,
      ],
      payer: this.adminPk,
      signers: [this.signer],
      lookupTableAccount: this.lookupTable,
    });
  });
});
