"use client";

import Image from "next/image";
import { motion } from "framer-motion";
import type { NavItem } from "@/types/landing";
import { ThemeToggle } from "@/components/ThemeToggle";

interface SiteHeaderProps {
  items: NavItem[];
  isAuthenticated?: boolean;
}

export function SiteHeader({ items, isAuthenticated = false }: SiteHeaderProps) {
  return (
    <motion.header
      className="site-header sticky top-0 z-30"
      initial={{ opacity: 0, y: -50 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.8, ease: "easeOut" }}
    >
      <div className="crypto-container site-header-row">
        <motion.a
          href="#home"
          className="site-logo-wrap"
          aria-label="TrustLend home"
          whileHover={{ scale: 1.05 }}
          transition={{ type: "spring", stiffness: 400, damping: 10 }}
        >
          <Image
            src="/logo.png"
            alt="TrustLend Logo"
            width={56}
            height={56}
            priority
            style={{ width: "56px", height: "56px", borderRadius: "50%", objectFit: "cover" }}
          />
          <span>
            <strong className="font-display site-logo-title">TrustLend</strong>
            <small className="site-logo-subtitle">Behavior-first credit network</small>
          </span>
        </motion.a>

        <nav className="site-nav-desktop" aria-label="Primary">
          {items.map((item, i) => (
            <motion.a
              key={item.href}
              href={item.href}
              className="site-nav-link"
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.3 + i * 0.05, ease: "easeOut" }}
              whileHover={{ scale: 1.1, color: "#7f2fd1", transition: { type: "spring", stiffness: 400, damping: 10 } }}
            >
              {item.label}
            </motion.a>
          ))}
        </nav>

        <motion.div
          className="site-header-actions"
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.5, delay: 0.6, ease: "easeOut" }}
        >
          <ThemeToggle />
          <a href="#faq" className="site-nav-utility">
            Need help?
          </a>
          {isAuthenticated ? (
            <motion.a
              href="/dashboard"
              className="google-btn google-btn-header"
              id="header-dashboard-btn"
              whileHover={{ scale: 1.05, y: -2 }}
              whileTap={{ scale: 0.95 }}
              transition={{ type: "spring", stiffness: 400, damping: 10 }}
            >
              Dashboard
            </motion.a>
          ) : (
            <motion.a
              href="/auth"
              className="google-btn google-btn-header"
              id="header-signin-btn"
              whileHover={{ scale: 1.05, y: -2 }}
              whileTap={{ scale: 0.95 }}
              transition={{ type: "spring", stiffness: 400, damping: 10 }}
            >
              Sign in
            </motion.a>
          )}
        </motion.div>
      </div>

      <div className="site-nav-mobile-wrap">
        <nav className="crypto-container site-nav-mobile" aria-label="Primary mobile">
          {items.map((item, i) => (
            <motion.a
              key={item.href}
              href={item.href}
              className="site-nav-link"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: 0.8 + i * 0.05, ease: "easeOut" }}
            >
              {item.label}
            </motion.a>
          ))}
        </nav>
      </div>
    </motion.header>
  );
}
