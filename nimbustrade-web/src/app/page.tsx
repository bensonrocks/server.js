import { Hero } from "@/components/sections/hero";
import { Credibility } from "@/components/sections/credibility";
import { Services } from "@/components/sections/services";
import { SolutionsSelector } from "@/components/sections/solutions-selector";
import { HowItWorks } from "@/components/sections/how-it-works";
import { Industries } from "@/components/sections/industries";
import { PlatformMockup } from "@/components/sections/platform-mockup";
import { CaseStudies } from "@/components/sections/case-studies";
import { ContactSection } from "@/components/sections/contact-section";

export default function Home() {
  return (
    <>
      <Hero />
      <Credibility />
      <Services />
      <SolutionsSelector />
      <HowItWorks />
      <Industries />
      <PlatformMockup />
      <CaseStudies />
      <ContactSection />
    </>
  );
}
