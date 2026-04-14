import { STELLAR_TESTNET, formatWalletAddress } from "@/lib/stellar/testnet";

interface WalletSetupCardProps {
  walletAddress: string | null;
}

export function WalletSetupCard({ walletAddress }: WalletSetupCardProps) {
  const shortAddress = formatWalletAddress(walletAddress);

  return (
    <article className="workspace-card workspace-card--full">
      <p className="premium-alert-badge">Wallet Setup</p>
      <h2 className="workspace-card-title">Stellar Testnet and test XLM</h2>
      <p className="workspace-card-copy" style={{ marginTop: "0.6rem" }}>
        Use Freighter on the Stellar testnet, fund the account with Friendbot, and keep this wallet ready for contract testing.
      </p>

      <div className="workspace-grid workspace-grid--three" style={{ marginTop: "1rem" }}>
        <div className="workspace-mini-stat">
          <span className="workspace-mini-stat-label">Network</span>
          <p className="workspace-mini-stat-value">{STELLAR_TESTNET.networkName}</p>
        </div>
        <div className="workspace-mini-stat">
          <span className="workspace-mini-stat-label">Horizon</span>
          <p className="workspace-mini-stat-value">Testnet API</p>
        </div>
        <div className="workspace-mini-stat">
          <span className="workspace-mini-stat-label">Wallet</span>
          <p className="workspace-mini-stat-value">{shortAddress}</p>
        </div>
      </div>

      <ul className="workspace-list workspace-list--compact" style={{ marginTop: "1rem" }}>
        <li><span>Install Freighter and create a new testnet account.</span></li>
        <li><span>Fund the account with Friendbot test XLM.</span></li>
        <li><span>Save the public key in your profile once wallet sync is wired.</span></li>
        <li><span>Use this same wallet for contract deploys and loan testing.</span></li>
      </ul>

      <div className="workspace-inline-actions" style={{ marginTop: "1rem" }}>
        <a className="workspace-nav-link" href={STELLAR_TESTNET.freighterUrl} target="_blank" rel="noreferrer">
          Open Freighter
        </a>
        <a className="workspace-nav-link" href={STELLAR_TESTNET.friendbotUrl} target="_blank" rel="noreferrer">
          Fund Test Wallet
        </a>
      </div>

      <p className="workspace-card-copy" style={{ marginTop: "1rem", fontSize: "0.9rem" }}>
        Network passphrase: {STELLAR_TESTNET.networkPassphrase}
      </p>
      <p className="workspace-card-copy" style={{ fontSize: "0.9rem" }}>
        Horizon endpoint: {STELLAR_TESTNET.horizonUrl}
      </p>
    </article>
  );
}