import { IntroSplash } from "@/components/intro-splash";
import { Hero } from "@/components/sections/hero";
import { Credibility } from "@/components/sections/credibility";
import { FacilityGallery } from "@/components/sections/facility-gallery";
import { Services } from "@/components/sections/services";
import { SolutionsSelector } from "@/components/sections/solutions-selector";
import { HowItWorks } from "@/components/sections/how-it-works";
import { Industries } from "@/components/sections/industries";
import { PlatformMockup } from "@/components/sections/platform-mockup";
import { PricingSignal } from "@/components/sections/pricing-signal";
import { ContactSection } from "@/components/sections/contact-section";

export default function Home() {
  return (
    <>
      <IntroSplash />
      <Hero />
      <Credibility />
      <FacilityGallery />
      <Services />
      <SolutionsSelector />
      <HowItWorks />
      <Industries />
      <PlatformMockup />
      <PricingSignal />
      <ContactSection />
    </>
  );
}
