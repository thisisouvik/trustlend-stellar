import Link from "next/link";
import { NotificationWidget } from "./NotificationWidget";

interface WorkspaceLink {
  href: string;
  label: string;
}

interface WorkspaceMetric {
  label: string;
  value: string;
}

interface ProfileSummary {
  completion: number;
  kycStatus: string;
  warningText: string;
  requiredItems: string[];
}

interface WorkspaceFrameProps {
  roleLabel: string;
  heading: string;
  description: string;
  email: string | null;
  userName?: string | null;
  metrics: WorkspaceMetric[];
  links: WorkspaceLink[];
  currentPath?: string;
  profilePath?: string;
  profileSummary?: ProfileSummary;
  headerWidget?: React.ReactNode;
  showProfileAlert?: boolean;
  children?: React.ReactNode;
}

export function WorkspaceFrame({
  roleLabel,
  heading,
  description,
  userName,
  metrics,
  links,
  currentPath,
  profilePath,
  profileSummary,
  headerWidget,
  showProfileAlert = true,
  children,
}: WorkspaceFrameProps) {
  const resolvedPath = currentPath ?? links[0]?.href ?? "/dashboard";
  const resolvedProfilePath = profilePath ?? links.find((item) => /profile|settings/i.test(item.label))?.href ?? links[0]?.href ?? "/dashboard";
  const displayName = userName && userName.trim() !== "" ? userName.trim() : "User";
  
  const resolvedProfileSummary: ProfileSummary = profileSummary ?? {
    completion: 40,
    kycStatus: "pending",
    warningText: "Complete your profile and KYC details to unlock all dashboard actions.",
    requiredItems: [
      "Upload government ID",
      "Verify phone number",
      "Add bank account details",
      "Enable 2FA",
    ],
  };

  const normalizedLinks = (() => {
    const seen = new Set<string>();
    return links.filter((item) => {
      if (seen.has(item.href)) {
        return false;
      }

      seen.add(item.href);
      return true;
    });
  })();

  return (
    <main className="role-dashboard-shell">
      <section className="role-dashboard-card role-dashboard-card--wide">
        <div className="workspace-layout">
          <aside className="workspace-sidebar" aria-label="Dashboard sidebar">
            <div className="workspace-brand-wrap">
              <Link href="/" className="workspace-brand font-display">
                TrustLend
              </Link>
              <p className="workspace-sidebar-kicker">{roleLabel}</p>
            </div>

            <nav className="workspace-sidebar-nav" aria-label={`${roleLabel} navigation`}>
              {normalizedLinks.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`workspace-sidebar-link ${resolvedPath === item.href ? "workspace-sidebar-link--active" : ""}`}
                >
                  {item.label}
                </Link>
              ))}
            </nav>

            {showProfileAlert ? (
              <section className="premium-alert" aria-live="polite">
                <p className="premium-alert-badge">Action Required</p>
                <div className="premium-alert-header">
                  <span className="premium-alert-icon" aria-hidden="true">
                    <span>!</span>
                  </span>
                  <p className="premium-alert-title">Profile & KYC</p>
                </div>
                <p className="workspace-profile-warning">High warning: complete profile to receive or grant loans.</p>
                <p className="workspace-profile-copy">{resolvedProfileSummary.warningText}</p>

                <div className="workspace-progress" style={{ margin: "0.8rem 0" }} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={resolvedProfileSummary.completion}>
                  <span style={{ width: `${resolvedProfileSummary.completion}%` }} />
                </div>

                {resolvedProfileSummary.requiredItems.length > 0 && (
                  <ul className="workspace-checklist">
                    {resolvedProfileSummary.requiredItems.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                )}

                <Link href={resolvedProfilePath} className="premium-alert-btn">
                  Complete Profile Now
                </Link>
              </section>
            ) : null}
          </aside>

          <div className="workspace-main-panel">
            <header className="workspace-topbar">
              <div>
                <h1 className="font-display role-title">{heading}</h1>
                <p className="role-description">{description}</p>
              </div>
              <div className="workspace-header-widget" aria-label="Dashboard controls">
                {headerWidget ?? (
                  <div className="workspace-top-actions">
                       <span className="workspace-chip">{displayName}</span>
                      <NotificationWidget />
                  </div>
                )}
              </div>
            </header>

            <div className="role-metrics role-metrics--four">
              {metrics.map((metric) => (
                <article key={metric.label} className="role-metric-card">
                  <p className="role-metric-value font-display">{metric.value}</p>
                  <p className="role-metric-label">{metric.label}</p>
                </article>
              ))}
            </div>

            {children ? <section className="workspace-content">{children}</section> : null}
          </div>
        </div>
      </section>
    </main>
  );
}
