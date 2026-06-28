import { motion } from "framer-motion";
import type { AboutContent, P2PStep } from "@/types/landing";

interface AboutSectionProps {
  content: AboutContent;
  steps: P2PStep[];
}

export function AboutSection({ content, steps }: AboutSectionProps) {
  return (
    <section id="p2p" className="section-anchor p2p-section">
      <div className="crypto-container py-20">
        <motion.h2
          className="p2p-title font-display"
          initial={{ opacity: 0, y: -30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.8, ease: "easeOut" }}
        >
          {content.title}
        </motion.h2>
        <motion.p
          className="p2p-description"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.8, delay: 0.2, ease: "easeOut" }}
        >
          {content.description}
        </motion.p>

        <div className="mt-10 grid gap-5 md:grid-cols-3">
          {steps.map((step, i) => (
            <motion.article
              key={step.step}
              className="p2p-card"
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-100px" }}
              transition={{ duration: 0.6, delay: i * 0.15, ease: "easeOut" }}
              whileHover={{ scale: 1.05, y: -10 }}
              transition={{ type: "spring", stiffness: 400, damping: 10 }}
            >
              <motion.span
                className="p2p-badge"
                initial={{ scale: 0, rotate: -180 }}
                whileInView={{ scale: 1, rotate: 0 }}
                viewport={{ once: true, margin: "-100px" }}
                transition={{ duration: 0.5, delay: i * 0.15 + 0.3, type: "spring" }}
              >
                {step.step}
              </motion.span>
              <h3 className="mt-4 font-display text-xl text-[#23114d]">{step.title}</h3>
              <p className="mt-2 text-sm text-slate-600">{step.description}</p>
            </motion.article>
          ))}
        </div>

        <motion.div
          className="mt-8 text-center"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.8, delay: 0.6, ease: "easeOut" }}
        >
          <motion.a
            href="/auth"
            className="p2p-button"
            whileHover={{ scale: 1.05, y: -3 }}
            whileTap={{ scale: 0.95 }}
            transition={{ type: "spring", stiffness: 400, damping: 10 }}
          >
            Start trading
          </motion.a>
        </motion.div>
      </div>
    </section>
  );
}
