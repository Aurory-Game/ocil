import {
  TransactionInstruction,
  Signer,
  Connection,
  TransactionMessage,
  VersionedTransaction,
  PublicKey,
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  Keypair,
} from "@solana/web3.js";

interface CreateAndSendV0Tx {
  txInstructions: TransactionInstruction[];
  payer: PublicKey;
  signers: Signer[];
  lookupTableAccount?: AddressLookupTableAccount;
  shouldLog?: boolean;
}

export class TxSender {
  connection: Connection;
  shouldLog: boolean;
  constructor(connection: Connection, shouldLog = false) {
    this.connection = connection;
    this.shouldLog = shouldLog;
  }

  private log(log, ...args) {
    if (log) {
      console.log(...args);
    }
  }

  async createAndSendV0Tx({
    txInstructions,
    payer,
    signers,
    lookupTableAccount,
    shouldLog,
  }: CreateAndSendV0Tx) {
    const log = shouldLog || this.shouldLog;
    let latestBlockhash = await this.connection.getLatestBlockhash("recent");

    this.log(
      log,
      "   ✅ - Fetched latest blockhash. Last valid height:",
      latestBlockhash.lastValidBlockHeight
    );

    const messageV0 = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: txInstructions,
    }).compileToV0Message(lookupTableAccount ? [lookupTableAccount] : []);
    this.log(log, "   ✅ - Compiled transaction message");
    const transaction = new VersionedTransaction(messageV0);

    transaction.sign(signers);
    this.log(log, "   ✅ - Transaction Signed");

    const txid = await this.connection.sendTransaction(transaction, {
      maxRetries: 5,
      skipPreflight: true,
    });
    this.log(log, "   ✅ - Transaction sent to network");
    let ptx = null;
    while (ptx === null) {
      ptx = await this.connection.getParsedTransaction(txid, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (log) {
      ptx?.meta?.logMessages
        ? ptx?.meta?.logMessages?.forEach((log) => {
            this.log(log, log);
          })
        : this.log(log, ptx);
    }
    if (ptx?.meta?.err) {
      throw new Error(ptx.meta.err.toString());
    } else {
      this.log(log, "   ✅ - Transaction executed successfully");
    }
  }
}

export async function createLookupTable(
  txSender: TxSender,
  payer: Keypair,
  addresses: PublicKey[]
): Promise<AddressLookupTableAccount> {
  const connection = txSender.connection;
  const slot = await connection.getSlot("finalized");
  const [createLookupTableInst, lookupTableAddress] =
    AddressLookupTableProgram.createLookupTable({
      authority: payer.publicKey,
      payer: payer.publicKey,
      recentSlot: slot,
    });
  const extendTableInst = AddressLookupTableProgram.extendLookupTable({
    /** Address lookup table account to extend. */
    lookupTable: lookupTableAddress,
    /** Account which is the current authority. */
    authority: payer.publicKey,
    /** Account that will fund the table reallocation.
     * Not required if the reallocation has already been funded. */
    payer: payer.publicKey,
    /** List of Public Keys to be added to the lookup table. */
    addresses,
  });

  await txSender.createAndSendV0Tx({
    txInstructions: [createLookupTableInst, extendTableInst],
    payer: payer.publicKey,
    signers: [payer],
  });
  const lookupTable = (
    await connection.getAddressLookupTable(lookupTableAddress)
  ).value;
  return lookupTable;
}
