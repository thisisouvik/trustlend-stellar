import { NextRequest, NextResponse } from "next/server";
import { TransactionBuilder, Keypair, Networks, Transaction } from "@stellar/stellar-sdk";

/**
 * TrustLend Advanced Feature: Fee Sponsorship (Gasless Transactions)
 * This endpoint allows the platform (Treasury) to sponsor transaction fees for borrowers.
 * By wrapping the user's signed transaction in a FeeBumpTransaction, the platform pays the gas,
 * enabling true "gasless" experiences for users without XLM balances.
 */
export async function POST(req: NextRequest) {
  try {
    const { xdr } = await req.json();
    
    if (!xdr) {
      return NextResponse.json({ error: "Missing transaction XDR" }, { status: 400 });
    }

    const networkPassphrase = process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE || Networks.TESTNET;
    const adminSecret = process.env.ADMIN_SECRET_KEY;
    
    if (!adminSecret) {
      // Simulation mode if key is not set up
      return NextResponse.json({
        success: true,
        message: "Fee Sponsorship Simulation: Admin secret key not configured. In production, this returns a signed FeeBumpTransaction.",
        sponsoredXdr: xdr,
        isSimulated: true
      });
    }

    // 1. Parse the inner transaction submitted by the client
    const innerTx = TransactionBuilder.fromXDR(xdr, networkPassphrase) as Transaction;
    
    // 2. Load the platform Treasury keypair
    const sponsorKeypair = Keypair.fromSecret(adminSecret);

    // 3. Wrap the transaction in a FeeBumpTransaction
    // The base fee is configured here (e.g., 100,000 stroops)
    const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
      sponsorKeypair,
      "100000",
      innerTx,
      networkPassphrase
    );

    // 4. Sign the FeeBump wrapper with the platform's key
    feeBumpTx.sign(sponsorKeypair);

    return NextResponse.json({
      success: true,
      message: "Transaction fees sponsored successfully.",
      sponsoredXdr: feeBumpTx.toXDR(),
      isSimulated: false
    });

  } catch (error) {
    return NextResponse.json({ 
      error: error instanceof Error ? error.message : "Failed to sponsor transaction" 
    }, { status: 500 });
  }
}
