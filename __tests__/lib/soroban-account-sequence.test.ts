import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/stellar/wallet", () => ({ signTransactionWithWallet: vi.fn() }));
vi.mock("@/lib/services/redis", () => ({ redis: null }));

import { Account, Keypair, rpc } from "@stellar/stellar-sdk";
import { getAccountSequence } from "@/lib/stellar/soroban";

describe("getAccountSequence", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("gets the account sequence through Stellar RPC", async () => {
    const address = Keypair.random().publicKey();
    const getAccount = vi
      .spyOn(rpc.Server.prototype, "getAccount")
      .mockResolvedValue(new Account(address, "123456789"));

    await expect(getAccountSequence(address)).resolves.toBe("123456789");
    expect(getAccount).toHaveBeenCalledWith(address);
  });

  it.each([
    "",
    "not-an-address",
    "../../admin",
    "GABC/../../evil",
    "CCLVI2JGD7PUV75VHOLTUZF3CVXYBUTOSLKNLHEUUFXOY73BFXUEVEMO",
    Keypair.random().publicKey().slice(0, 55),
    Keypair.random().publicKey() + "?x=1",
  ])("rejects malformed address %j before making an RPC request", async (address) => {
    const getAccount = vi.spyOn(rpc.Server.prototype, "getAccount");
    await expect(getAccountSequence(address)).rejects.toThrow(/Invalid Stellar account address/);
    expect(getAccount).not.toHaveBeenCalled();
  });

  it("rejects non-string input before making an RPC request", async () => {
    const getAccount = vi.spyOn(rpc.Server.prototype, "getAccount");
    await expect(getAccountSequence(undefined as unknown as string)).rejects.toThrow(
      /Invalid Stellar account address/,
    );
    expect(getAccount).not.toHaveBeenCalled();
  });

  it("reports an unfunded account when the RPC lookup fails", async () => {
    const address = Keypair.random().publicKey();
    vi.spyOn(rpc.Server.prototype, "getAccount").mockRejectedValue(new Error("Account not found"));

    await expect(getAccountSequence(address)).rejects.toThrow(/not found on Stellar network/);
  });
});
