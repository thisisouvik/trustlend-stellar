import { CheckCircle2 } from "lucide-react";
import type { ReasonItem } from "@/types/landing";

interface UspSectionProps {
  items: ReasonItem[];
}

export function UspSection({ items }: UspSectionProps) {
  return (
    <section className="section-anchor reasons-section">
      <div className="crypto-container py-20">
        <h2 className="reasons-title font-display">Why TrustLend?</h2>

        <div className="reasons-card">
          <ul className="space-y-4">
            {items.map((item) => (
              <li key={item.title} className="reasons-item">
                <CheckCircle2 size={18} className="text-[#2ad39f]" />
                <span>{item.title}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
