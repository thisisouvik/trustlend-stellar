"use client";

import { MonitorPlay, TrendingUp, ShieldCheck, Zap } from "lucide-react";

import { motion } from "framer-motion";
import type { HighlightContent, MetricItem } from "@/types/landing";

interface ServicesSectionProps {
  metrics: MetricItem[];
  content: HighlightContent;
}

// Animated bar chart component
const AnimatedBarChart = () => {
  const barHeights = [40, 65, 50, 80, 60, 90];

  return (
    <div className="dashboard-chart">
      <div className="dashboard-chart-bars">
        {barHeights.map((height, i) => (
          <motion.span
            key={i}
            initial={{ height: 0, opacity: 0 }}
            whileInView={{ height: `${height}%`, opacity: 0.8 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.8, delay: i * 0.1, ease: "easeOut" }}
          />
        ))}
      </div>
      <span className="dashboard-caption" style={{ marginTop: "0.5rem" }}>Loan volume</span>
    </div>
  );
};

export function ServicesSection({ metrics, content }: ServicesSectionProps) {
  return (
    <>
      <section id="introduce" className="metrics-strip section-anchor">
        <div className="crypto-container grid gap-5 py-10 md:grid-cols-4">
          {metrics.map((item, i) => (
            <motion.article
              key={item.label}
              className="metric-card"
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-100px" }}
              transition={{ duration: 0.6, delay: i * 0.1, ease: "easeOut" }}
              whileHover={{ scale: 1.05, y: -5 }}
            >
              <p className="metric-value font-display">{item.value}</p>
              <p className="metric-label">{item.label}</p>
            </motion.article>
          ))}
        </div>
      </section>

      <section className="showcase-section">
        <div className="crypto-container grid items-center gap-12 py-20 lg:grid-cols-[0.9fr_1.1fr]">
          <motion.article
            initial={{ opacity: 0, x: -50 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.8, ease: "easeOut" }}
          >
            <p className="showcase-kicker">HIGHLIGHT</p>
            <h2 className="showcase-title font-display">{content.title}</h2>
            <p className="showcase-description">{content.description}</p>
            <p className="showcase-callout">{content.callout}</p>

            {/* Project summary blurb */}
            <div className="showcase-project-blurb">
              {[
                { icon: ShieldCheck, text: "4 Soroban smart contracts live on Stellar Testnet" },
                { icon: Zap, text: "On-chain reputation scoring — no collateral required" },
                { icon: TrendingUp, text: "Escrow-protected disbursement with 3-min revocation window" },
              ].map((item, i) => (
                <motion.div
                  key={i}
                  className="showcase-blurb-item"
                  initial={{ opacity: 0, x: -20 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true, margin: "-100px" }}
                  transition={{ duration: 0.5, delay: i * 0.15, ease: "easeOut" }}
                >
                  <item.icon size={16} className="showcase-blurb-icon" />
                  <span>{item.text}</span>
                </motion.div>
              ))}
            </div>
          </motion.article>

          <motion.article
            className="dashboard-shell"
            initial={{ opacity: 0, x: 50 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.8, delay: 0.3, ease: "easeOut" }}
          >
            <div className="dashboard-bar" />
            <div className="dashboard-grid">
              <motion.div
                className="dashboard-card dashboard-card-strong"
                whileHover={{ scale: 1.05, y: -5 }}
                transition={{ type: "spring", stiffness: 400, damping: 10 }}
              >
                <span className="dashboard-caption">Trust graph</span>
                <TrendingUp size={18} />
                <span className="dashboard-card-stat">+82 pts</span>
              </motion.div>
              <motion.div
                className="dashboard-card dashboard-card-accent"
                whileHover={{ scale: 1.05, y: -5 }}
                transition={{ type: "spring", stiffness: 400, damping: 10 }}
              >
                <span className="dashboard-caption">Risk monitor</span>
                <MonitorPlay size={18} />
                <span className="dashboard-card-stat">LOW</span>
              </motion.div>
              <AnimatedBarChart />
              <div className="dashboard-mini">
                <span className="dashboard-caption">Insurance pool</span>
                <span className="dashboard-mini-value">Funded</span>
              </div>
            </div>
          </motion.article>
        </div>
      </section>
    </>
  );
}
