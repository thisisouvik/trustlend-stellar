import type { AboutContent, P2PStep } from "@/types/landing";

interface AboutSectionProps {
  content: AboutContent;
  steps: P2PStep[];
}

export function AboutSection({ content, steps }: AboutSectionProps) {
  return (
    <section id="p2p" className="section-anchor p2p-section">
      <div className="crypto-container py-20">
        <h2 className="p2p-title font-display">{content.title}</h2>
        <p className="p2p-description">{content.description}</p>

        <div className="mt-10 grid gap-5 md:grid-cols-3">
          {steps.map((step) => (
            <article key={step.step} className="p2p-card">
              <span className="p2p-badge">{step.step}</span>
              <h3 className="mt-4 font-display text-xl text-[#23114d]">{step.title}</h3>
              <p className="mt-2 text-sm text-slate-600">{step.description}</p>
            </article>
          ))}
        </div>

        <div className="mt-8 text-center">
          <a href="/auth" className="p2p-button">
            Start trading
          </a>
        </div>
      </div>
    </section>
  );
}
