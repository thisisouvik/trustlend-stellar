import type { StepItem } from "@/types/landing";

interface ProcessSectionProps {
  steps: StepItem[];
}

export function ProcessSection({ steps }: ProcessSectionProps) {
  return (
    <section id="journey" className="section-anchor journey-section">
      <div className="crypto-container grid items-start gap-10 py-20 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="space-y-4">
          {steps.map((step) => (
            <article key={step.step} className="journey-step-card">
              <div className="journey-step-badge">Step {step.step}</div>
              <div>
                <h3 className="font-display text-lg text-[#2c2a53]">{step.title}</h3>
                <p className="mt-1 text-sm text-slate-600">{step.description}</p>
              </div>
            </article>
          ))}
        </div>

        <article className="journey-cta">
          <p className="journey-kicker">JOIN EASILY WITH JUST</p>
          <h2 className="font-display text-5xl text-[#7325c8]">5 Steps</h2>
          <a href="/auth" className="journey-button">
            Start now
          </a>
        </article>
      </div>
    </section>
  );
}
