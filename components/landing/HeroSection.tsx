import Image from "next/image";
import { motion } from "framer-motion";
import { useEffect, useMemo, useRef } from "react";
import type { HeroContent } from "@/types/landing";

interface HeroSectionProps {
  content: HeroContent;
  isAuthenticated?: boolean;
}

// Particle component for decorative effects
const Particle = ({ x, y, delay }: { x: number; y: number; delay: number }) => {
  return (
    <motion.div
      className="absolute rounded-full bg-gradient-to-br from-purple-500/30 to-teal-400/30"
      style={{
        left: `${x}%`,
        top: `${y}%`,
        width: Math.random() * 20 + 8,
        height: Math.random() * 20 + 8,
      }}
      initial={{ opacity: 0, scale: 0, y: 20 }}
      animate={{
        opacity: [0.3, 0.8, 0.3],
        scale: [1, 1.3, 1],
        y: [0, -30, 0],
      }}
      transition={{
        duration: Math.random() * 4 + 3,
        repeat: Infinity,
        delay,
        ease: "easeInOut",
      }}
    />
  );
};

export function HeroSection({ content, isAuthenticated = false }: HeroSectionProps) {
  // Generate particles once on mount
  const particles = useMemo(() => {
    return Array.from({ length: 20 }).map((_, i) => ({
      id: i,
      x: Math.random() * 100,
      y: Math.random() * 100,
      delay: Math.random() * 3,
    }));
  }, []);

  return (
    <section id="home" className="hero-section section-anchor">
      {/* Particle background */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        {particles.map((p) => (
          <Particle key={p.id} x={p.x} y={p.y} delay={p.delay} />
        ))}
      </div>

      <div className="crypto-container hero-grid">
        <motion.article
          className="hero-copy"
          initial={{ opacity: 0, x: -50 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.8, ease: "easeOut" }}
        >
          {/* Eyebrow — styled badge */}
          <motion.div
            className="hero-eyebrow-badge"
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.2, ease: "easeOut" }}
          >
            <span className="hero-eyebrow-dot" />
            {content.eyebrow}
          </motion.div>

          {/* Title — each part forced to its own line */}
          <motion.h1
            className="hero-title font-display"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.4, ease: "easeOut" }}
          >
            <span className="hero-title-line">{content.titleMain}</span>
            <span className="hero-title-line hero-title-accent">{content.titleAccent}</span>
          </motion.h1>

          <motion.p
            className="hero-description"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.6, ease: "easeOut" }}
          >
            {content.description}
          </motion.p>

          <motion.div
            className="hero-trust-pills"
            role="list"
            aria-label="TrustLend highlights"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.8, ease: "easeOut" }}
          >
            {["Borrower flow", "Lender flow", "Real behavior scoring"].map((pill, i) => (
              <motion.span
                key={pill}
                className="hero-trust-pill"
                role="listitem"
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.3, delay: 1 + i * 0.1, ease: "easeOut" }}
              >
                {pill}
              </motion.span>
            ))}
          </motion.div>

          <motion.div
            className="hero-cta-wrap"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 1.2, ease: "easeOut" }}
          >
            <a
              href={isAuthenticated ? "/dashboard" : "/auth"}
              className="google-btn google-btn-hero"
              id="hero-start-btn"
            >
              {isAuthenticated ? "Go to Dashboard →" : "Start now →"}
            </a>
          </motion.div>

          <motion.p
            className="hero-subnote"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6, delay: 1.4, ease: "easeOut" }}
          >
            Choose your role during sign-in. Dashboard is automatically split by role.
          </motion.p>
        </motion.article>

        <motion.article
          className="hero-visual"
          aria-hidden="true"
          initial={{ opacity: 0, x: 50 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.8, delay: 0.5, ease: "easeOut" }}
        >
          <div className="hero-visual-glow" />
          <motion.div
            className="hero-art"
            animate={{ y: [0, -15, 0] }}
            transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
          >
            <Image
              src="/assets/hero-trust.png"
              alt=""
              fill
              priority
              sizes="(max-width: 960px) 100vw, 50vw"
              className="object-contain"
            />
          </motion.div>
          <motion.div
            className="hero-stat hero-stat-tl"
            animate={{
              y: [0, -10, 0],
              boxShadow: [
                "0 4px 12px rgba(0,0,0,0.1)",
                "0 8px 24px rgba(0,0,0,0.2)",
                "0 4px 12px rgba(0,0,0,0.1)",
              ],
            }}
            transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
          >
            <span className="hero-stat-val">Trust</span>
            <span className="hero-stat-label">Live risk signal</span>
          </motion.div>
          <motion.div
            className="hero-stat hero-stat-br"
            animate={{
              y: [0, 10, 0],
              boxShadow: [
                "0 4px 12px rgba(0,0,0,0.1)",
                "0 8px 24px rgba(0,0,0,0.2)",
                "0 4px 12px rgba(0,0,0,0.1)",
              ],
            }}
            transition={{ duration: 5, repeat: Infinity, ease: "easeInOut", delay: 0.5 }}
          >
            <span className="hero-stat-val">3.4k</span>
            <span className="hero-stat-label">Active users</span>
          </motion.div>
        </motion.article>
      </div>
    </section>
  );
}
