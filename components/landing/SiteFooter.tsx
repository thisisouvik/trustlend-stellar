import type { FooterLink } from "@/types/landing";

interface SiteFooterProps {
  links: FooterLink[];
}

export function SiteFooter({ links }: SiteFooterProps) {
  return (
    <footer className="site-footer py-14">
      <div className="crypto-container site-footer-grid">
        <div>
          <h2 className="font-display site-footer-brand">TrustLend</h2>
          <p className="site-footer-tagline">Credit infrastructure built on real behavior, not collateral bias.</p>
          <p className="site-footer-subtext">
            Borrowers and lenders collaborate in one transparent network where every repayment strengthens the next
            opportunity.
          </p>
        </div>

        <div className="grid gap-6 sm:grid-cols-2">
          <div>
            <h3 className="site-footer-heading">Explore</h3>
            <ul className="site-footer-list mt-3 space-y-2 text-sm">
              {links.map((link) => (
                <li key={link.href}>
                  <a href={link.href} className="site-footer-link">
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 className="site-footer-heading">Contact</h3>
            <ul className="site-footer-list mt-3 space-y-2 text-sm">
              <li>support@trustlend.io</li>
              <li>Global community-first network</li>
              <li>Version v1.2.3</li>
            </ul>
          </div>
        </div>
      </div>

      <div className="crypto-container site-footer-bottom">
        <p>© 2026 TrustLend. All rights reserved.</p>
        <p>Secure role-based dashboards for lenders and borrowers.</p>
      </div>
    </footer>
  );
}
