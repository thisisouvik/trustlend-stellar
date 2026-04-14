import type { FaqItem } from "@/types/landing";

interface FaqSectionProps {
  items: FaqItem[];
}

export function FaqSection({ items }: FaqSectionProps) {
  return (
    <section id="faq" className="section-anchor faq-section">
      <div className="crypto-container py-20">
        <div className="faq-grid">
          <aside className="faq-sidebar">
            <h3 className="font-display text-lg text-[#1d254a]">FAQs</h3>
            <ul className="mt-4 space-y-2 text-sm text-slate-600">
              <li className="faq-chip faq-chip-active">General</li>
              <li className="faq-chip">Account</li>
              <li className="faq-chip">Wallet and Asset</li>
              <li className="faq-chip">Transactions</li>
              <li className="faq-chip">Disputes</li>
            </ul>
          </aside>

          <article className="faq-main">
            {items.map((item, index) => (
              <details key={item.question} className="faq-item" open={index === 0}>
                <summary>{item.question}</summary>
                <p>{item.answer}</p>
              </details>
            ))}
          </article>
        </div>
      </div>
    </section>
  );
}
