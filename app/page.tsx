import {
  AboutSection,
  FaqSection,
  HeroSection,
  ProcessSection,
  ServicesSection,
  SiteFooter,
  SiteHeader,
  UspSection,
} from "@/components/landing";
import { getServerSupabaseClient } from "@/lib/supabase/server";
import {
  aboutContent,
  faqItems,
  footerLinks,
  heroContent,
  highlightContent,
  metrics,
  navItems,
  p2pSteps,
  processSteps,
  reasons,
} from "@/lib/content/landing-content";

export default async function Home() {
  const supabase = await getServerSupabaseClient();
  let isAuthenticated = false;

  if (supabase) {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    isAuthenticated = Boolean(user);
  }

  return (
    <div className="site-shell">
      <SiteHeader items={navItems} isAuthenticated={isAuthenticated} />

      <main>
        <HeroSection content={heroContent} isAuthenticated={isAuthenticated} />
        <ServicesSection metrics={metrics} content={highlightContent} />
        <ProcessSection steps={processSteps} />
        <UspSection items={reasons} />
        <AboutSection content={aboutContent} steps={p2pSteps} />
        <FaqSection items={faqItems} />
      </main>

      <SiteFooter links={footerLinks} />
    </div>
  );
}
