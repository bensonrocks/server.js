import { marketingMeta, HOME_TITLE, SITE_DESCRIPTION } from "@/lib/site-config";
import { IntroSplash } from "@/components/intro-splash";
import { Hero } from "@/components/sections/hero";
import { Explainer } from "@/components/sections/explainer";
import { Credibility } from "@/components/sections/credibility";
import { FacilityGallery } from "@/components/sections/facility-gallery";
import { Services } from "@/components/sections/services";
import { SolutionsSelector } from "@/components/sections/solutions-selector";
import { HowItWorks } from "@/components/sections/how-it-works";
import { Industries } from "@/components/sections/industries";
import { PlatformMockup } from "@/components/sections/platform-mockup";
import { PricingSignal } from "@/components/sections/pricing-signal";
import { ContactSection } from "@/components/sections/contact-section";

export const metadata = marketingMeta({
  title: HOME_TITLE,
  description: SITE_DESCRIPTION,
  path: "/",
  absoluteTitle: true,
});

export default function Home() {
  return (
    <>
      <IntroSplash />
      <Hero />
      <Explainer />
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
