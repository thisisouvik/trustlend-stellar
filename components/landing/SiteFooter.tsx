"use client";

import { motion } from "framer-motion";
import type { FooterLink } from "@/types/landing";

interface SiteFooterProps {
  links: FooterLink[];
}

export function SiteFooter({ links }: SiteFooterProps) {
  return (
    <motion.footer
      className="site-footer py-14"
      initial={{ opacity: 0, y: 50 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-100px" }}
      transition={{ duration: 0.8, ease: "easeOut" }}
    >
      <div className="crypto-container site-footer-grid">
        <motion.div
        initial={{ opacity: 0, x: -30 }}
        whileInView={{ opacity: 1, x: 0 }}
        viewport={{ once: true, margin: "-100px" }}
        transition={{ duration: 0.6, ease: "easeOut" }}
      >
          <h2 className="font-display site-footer-brand">TrustLend</h2>
          <p className="site-footer-tagline">Credit infrastructure built on real behavior, not collateral bias.</p>
          <p className="site-footer-subtext">
            Borrowers and lenders collaborate in one transparent network where every repayment strengthens the next
            opportunity.
          </p>
        </motion.div>

        <div className="grid gap-6 sm:grid-cols-2">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.6, delay: 0.2, ease: "easeOut" }}
          >
            <h3 className="site-footer-heading">Explore</h3>
            <ul className="site-footer-list mt-3 space-y-2 text-sm">
              {links.map((link, i) => (
                <motion.li
                  key={link.href}
                  initial={{ opacity: 0, x: 20 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true, margin: "-100px" }}
                  transition={{ duration: 0.4, delay: 0.3 + i * 0.1, ease: "easeOut" }}
                  whileHover={{ x: 5 }}
                >
                  <a href={link.href} className="site-footer-link">
                    {link.label}
                  </a>
                </motion.li>
              ))}
            </ul>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.6, delay: 0.4, ease: "easeOut" }}
          >
            <h3 className="site-footer-heading">Contact</h3>
            <ul className="site-footer-list mt-3 space-y-2 text-sm">
              <li>support@trustlend.io</li>
              <li>Global community-first network</li>
              <li>Version v1.2.3</li>
            </ul>
          </motion.div>
        </div>
      </div>

      <motion.div
        className="crypto-container site-footer-bottom"
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true, margin: "-100px" }}
        transition={{ duration: 0.6, delay: 0.6, ease: "easeOut" }}
      >
        <p>© 2026 TrustLend. All rights reserved.</p>
        <p>Secure role-based dashboards for lenders and borrowers.</p>
      </motion.div>
    </motion.footer>
  );
}
