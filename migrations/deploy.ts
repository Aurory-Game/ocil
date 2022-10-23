// Migrations are an early feature. Currently, they're nothing more than this
// single deploy script that's invoked from the CLI, injecting a provider
// configured from the workspace's Anchor.toml.

import * as anchor from "@project-serum/anchor";
import { Program, AnchorProvider, Wallet } from "@project-serum/anchor";
import { Casier } from "../target/types/casier";
import {
  PublicKey,
  Connection,
  Keypair,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import * as fs from "fs";

function loadKeypair(keypairPath: string): any {
  return <any>JSON.parse(fs.readFileSync(keypairPath).toString());
}

function loadWallet(keypair: string): Keypair {
  return Keypair.fromSecretKey(new Uint8Array(loadKeypair(keypair)));
}

const fee_payer = loadWallet(process.env.FEE_PAYER_KEY_PATH);

module.exports = async function () {
  // Configure client to use the provider.
  const idl = JSON.parse(
    require("fs")
      .readFileSync(`${process.cwd()}/../target/idl/casier.json`, "utf8")
      .toString()
  );
  const connection = new Connection(process.env.RPC_ENDPOINT, "recent");
  const wallet = new Wallet(fee_payer);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "recent",
  });
  const program = new Program<Casier>(
    idl,
    new PublicKey("CAsieqooSrgVxhgWRwh21gyjq7Rmuhmo4qTW9XzXtAvW"),
    provider
  );
  const tx1 = await program.methods.initialize().rpc();
  console.log(tx1);
  const [configPDA] = await PublicKey.findProgramAddress(
    [anchor.utils.bytes.utf8.encode("config")],
    program.programId
  );
  const tx2 = await program.methods
    .initConfig()
    .accounts({
      config: configPDA,
      feePayer: fee_payer.publicKey,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();
  console.log(tx2);

  // Add your deploy script here.
};
