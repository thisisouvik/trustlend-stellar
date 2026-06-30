"use client";

import { CheckCircle2 } from "lucide-react";
import { motion } from "framer-motion";
import type { ReasonItem } from "@/types/landing";

interface UspSectionProps {
  items: ReasonItem[];
}

export function UspSection({ items }: UspSectionProps) {
  return (
    <section className="section-anchor reasons-section">
      <div className="crypto-container py-20">
        <motion.h2
          className="reasons-title font-display"
          initial={{ opacity: 0, y: -30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.8, ease: "easeOut" }}
        >
          Why TrustLend?
        </motion.h2>

        <motion.div
          className="reasons-card"
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.8, delay: 0.2, ease: "easeOut" }}
        >
          <ul className="space-y-4">
            {items.map((item, i) => (
              <motion.li
                key={item.title}
                className="reasons-item"
                initial={{ opacity: 0, x: -30 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true, margin: "-100px" }}
                transition={{ duration: 0.5, delay: i * 0.1, ease: "easeOut" }}
                whileHover={{ x: 10 }}
              >
                <motion.div
                  initial={{ scale: 0 }}
                  whileInView={{ scale: 1 }}
                  viewport={{ once: true, margin: "-100px" }}
                  transition={{ duration: 0.3, delay: i * 0.1 + 0.3, type: "spring" }}
                >
                  <CheckCircle2 size={18} className="text-[#2ad39f]" />
                </motion.div>
                <span>{item.title}</span>
              </motion.li>
            ))}
          </ul>
        </motion.div>
      </div>
    </section>
  );
}
