import { Keypair } from "@solana/web3.js";
import * as fs from "fs";

function loadKeypair(keypairPath: string): any {
  return <any>JSON.parse(fs.readFileSync(keypairPath).toString());
}

export function loadWallet(keypair: string): Keypair {
  return Keypair.fromSecretKey(new Uint8Array(loadKeypair(keypair)));
}
