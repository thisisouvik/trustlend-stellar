import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { FaqItem } from "@/types/landing";

interface FaqSectionProps {
  items: FaqItem[];
}

export function FaqSection({ items }: FaqSectionProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <section id="faq" className="section-anchor faq-section">
      <div className="crypto-container py-20">
        <div className="faq-grid">
          <motion.aside
            className="faq-sidebar"
            initial={{ opacity: 0, x: -30 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.8, ease: "easeOut" }}
          >
            <h3 className="font-display text-lg text-[#1d2548]">FAQs</h3>
            <ul className="mt-4 space-y-2 text-sm text-slate-600">
              {["General", "Account", "Wallet and Asset", "Transactions", "Disputes"].map((chip, i) => (
                <motion.li
                  key={chip}
                  className={`faq-chip ${i === 0 ? "faq-chip-active" : ""}`}
                  whileHover={{ scale: 1.05, x: 5 }}
                  transition={{ type: "spring", stiffness: 400, damping: 10 }}
                >
                  {chip}
                </motion.li>
              ))}
            </ul>
          </motion.aside>

          <article className="faq-main">
            {items.map((item, index) => (
              <motion.div
                key={item.question}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-100px" }}
                transition={{ duration: 0.5, delay: index * 0.1, ease: "easeOut" }}
              >
                <details
                  className="faq-item"
                  open={openIndex === index}
                  onToggle={(e) => {
                    setOpenIndex(e.currentTarget.open ? index : null);
                  }}
                >
                  <summary className="cursor-pointer">{item.question}</summary>
                  <AnimatePresence>
                    {openIndex === index && (
                      <motion.p
                        initial={{ opacity: 0, height: 0, marginTop: 0 }}
                        animate={{ opacity: 1, height: "auto", marginTop: "0.5rem" }}
                        exit={{ opacity: 0, height: 0, marginTop: 0 }}
                        transition={{ duration: 0.3, ease: "easeInOut" }}
                      >
                        {item.answer}
                      </motion.p>
                    )}
                  </AnimatePresence>
                </details>
              </motion.div>
            ))}
          </article>
        </div>
      </div>
    </section>
  );
}
