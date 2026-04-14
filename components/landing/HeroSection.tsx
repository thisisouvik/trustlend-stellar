import Image from "next/image";
import type { HeroContent } from "@/types/landing";

interface HeroSectionProps {
  content: HeroContent;
  isAuthenticated?: boolean;
}

export function HeroSection({ content, isAuthenticated = false }: HeroSectionProps) {
  return (
    <section id="home" className="hero-section section-anchor">
      <div className="crypto-container hero-grid">
        <article className="hero-copy">

          {/* Eyebrow — styled badge */}
          <div className="hero-eyebrow-badge">
            <span className="hero-eyebrow-dot" />
            {content.eyebrow}
          </div>

          {/* Title — each part forced to its own line */}
          <h1 className="hero-title font-display">
            <span className="hero-title-line">{content.titleMain}</span>
            <span className="hero-title-line hero-title-accent">{content.titleAccent}</span>
          </h1>

          <p className="hero-description">{content.description}</p>

          <div className="hero-trust-pills" role="list" aria-label="TrustLend highlights">
            <span className="hero-trust-pill" role="listitem">Borrower flow</span>
            <span className="hero-trust-pill" role="listitem">Lender flow</span>
            <span className="hero-trust-pill" role="listitem">Real behavior scoring</span>
          </div>

          <div className="hero-cta-wrap">
            <a
              href={isAuthenticated ? "/dashboard" : "/auth"}
              className="google-btn google-btn-hero"
              id="hero-start-btn"
            >
              {isAuthenticated ? "Go to Dashboard →" : "Start now →"}
            </a>
          </div>

          <p className="hero-subnote">
            Choose your role during sign-in. Dashboard is automatically split by role.
          </p>
        </article>

        <article className="hero-visual" aria-hidden="true">
          <div className="hero-visual-glow" />
          <div className="hero-art">
            <Image
              src="/assets/hero-trust.png"
              alt=""
              fill
              priority
              sizes="(max-width: 960px) 100vw, 50vw"
              className="object-contain"
            />
          </div>
          <div className="hero-stat hero-stat-tl">
            <span className="hero-stat-val">Trust</span>
            <span className="hero-stat-label">Live risk signal</span>
          </div>
          <div className="hero-stat hero-stat-br">
            <span className="hero-stat-val">3.4k</span>
            <span className="hero-stat-label">Active users</span>
          </div>
        </article>
      </div>
    </section>
  );
}
