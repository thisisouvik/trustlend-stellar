import { MonitorPlay, TrendingUp, ShieldCheck, Zap } from "lucide-react";
import type { HighlightContent, MetricItem } from "@/types/landing";

interface ServicesSectionProps {
  metrics: MetricItem[];
  content: HighlightContent;
}

export function ServicesSection({ metrics, content }: ServicesSectionProps) {
  return (
    <>
      <section id="introduce" className="metrics-strip section-anchor">
        <div className="crypto-container grid gap-5 py-10 md:grid-cols-4">
          {metrics.map((item) => (
            <article key={item.label} className="metric-card">
              <p className="metric-value font-display">{item.value}</p>
              <p className="metric-label">{item.label}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="showcase-section">
        <div className="crypto-container grid items-center gap-12 py-20 lg:grid-cols-[0.9fr_1.1fr]">
          <article>
            <p className="showcase-kicker">HIGHLIGHT</p>
            <h2 className="showcase-title font-display">{content.title}</h2>
            <p className="showcase-description">{content.description}</p>
            <p className="showcase-callout">{content.callout}</p>

            {/* Project summary blurb */}
            <div className="showcase-project-blurb">
              <div className="showcase-blurb-item">
                <ShieldCheck size={16} className="showcase-blurb-icon" />
                <span>4 Soroban smart contracts live on Stellar Testnet</span>
              </div>
              <div className="showcase-blurb-item">
                <Zap size={16} className="showcase-blurb-icon" />
                <span>On-chain reputation scoring — no collateral required</span>
              </div>
              <div className="showcase-blurb-item">
                <TrendingUp size={16} className="showcase-blurb-icon" />
                <span>Escrow-protected disbursement with 3-min revocation window</span>
              </div>
            </div>
          </article>

          <article className="dashboard-shell">
            <div className="dashboard-bar" />
            <div className="dashboard-grid">
              <div className="dashboard-card dashboard-card-strong">
                <span className="dashboard-caption">Trust graph</span>
                <TrendingUp size={18} />
                <span className="dashboard-card-stat">+82 pts</span>
              </div>
              <div className="dashboard-card dashboard-card-accent">
                <span className="dashboard-caption">Risk monitor</span>
                <MonitorPlay size={18} />
                <span className="dashboard-card-stat">LOW</span>
              </div>
              <div className="dashboard-chart">
                <div className="dashboard-chart-bars">
                  <span style={{ height: "40%" }} />
                  <span style={{ height: "65%" }} />
                  <span style={{ height: "50%" }} />
                  <span style={{ height: "80%" }} />
                  <span style={{ height: "60%" }} />
                  <span style={{ height: "90%" }} />
                </div>
                <span className="dashboard-caption" style={{ marginTop: "0.5rem" }}>Loan volume</span>
              </div>
              <div className="dashboard-mini">
                <span className="dashboard-caption">Insurance pool</span>
                <span className="dashboard-mini-value">Funded</span>
              </div>
            </div>
          </article>
        </div>
      </section>
    </>
  );
}
