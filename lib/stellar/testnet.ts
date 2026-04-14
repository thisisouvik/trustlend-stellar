export const STELLAR_TESTNET = {
  networkName: "Stellar Testnet",
  networkPassphrase: "Test SDF Network ; September 2015",
  horizonUrl: "https://horizon-testnet.stellar.org",
  friendbotUrl: "https://friendbot.stellar.org",
  freighterUrl: "https://www.freighter.app/",
} as const;

export function formatWalletAddress(address: string | null | undefined) {
  if (!address) {
    return "No wallet saved yet";
  }

  if (address.length <= 10) {
    return address;
  }

  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}