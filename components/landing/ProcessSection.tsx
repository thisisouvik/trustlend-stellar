import { motion } from "framer-motion";
import type { StepItem } from "@/types/landing";

interface ProcessSectionProps {
  steps: StepItem[];
}

export function ProcessSection({ steps }: ProcessSectionProps) {
  return (
    <section id="journey" className="section-anchor journey-section">
      <div className="crypto-container grid items-start gap-10 py-20 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="space-y-4">
          {steps.map((step, i) => (
            <motion.article
              key={step.step}
              className="journey-step-card"
              initial={{ opacity: 0, x: -30 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true, margin: "-100px" }}
              transition={{ duration: 0.6, delay: i * 0.15, ease: "easeOut" }}
              whileHover={{ scale: 1.02, x: 5 }}
            >
              <motion.div
                className="journey-step-badge"
                whileHover={{ scale: 1.1, rotate: 5 }}
              >
                Step {step.step}
              </motion.div>
              <div>
                <h3 className="font-display text-lg text-[#2c2a53]">{step.title}</h3>
                <p className="mt-1 text-sm text-slate-600">{step.description}</p>
              </div>
            </motion.article>
          ))}
        </div>

        <motion.article
          className="journey-cta"
          initial={{ opacity: 0, x: 50 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.8, ease: "easeOut" }}
        >
          <p className="journey-kicker">JOIN EASILY WITH JUST</p>
          <motion.h2
            className="font-display text-5xl text-[#7325c8]"
            animate={{
              scale: [1, 1.05, 1],
            }}
            transition={{
              duration: 3,
              repeat: Infinity,
              ease: "easeInOut",
            }}
          >
            5 Steps
          </motion.h2>
          <motion.a
            href="/auth"
            className="journey-button"
            whileHover={{ scale: 1.05, y: -3 }}
            whileTap={{ scale: 0.95 }}
            transition={{ type: "spring", stiffness: 400, damping: 10 }}
          >
            Start now
          </motion.a>
        </motion.article>
      </div>
    </section>
  );
}
