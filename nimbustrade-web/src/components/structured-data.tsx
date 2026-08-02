import { SITE_URL, SITE_NAME, SITE_DESCRIPTION, SELF_RUN_MARKETS, PARTNER_MARKETS } from "@/lib/site-config";

export function OrganizationJsonLd() {
  const data = {
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    "@id": `${SITE_URL}/#organization`,
    name: SITE_NAME,
    alternateName: "云腾贸易方案私人有限公司",
    url: SITE_URL,
    logo: `${SITE_URL}/logo.png`,
    image: `${SITE_URL}/og-image.png`,
    description: SITE_DESCRIPTION,
    email: "info@nimbustrade.co",
    telephone: "+65-8877-6106",
    address: {
      "@type": "PostalAddress",
      streetAddress: "62 Ubi Road 1, Oxley Bizhub 2, #06-01",
      addressLocality: "Singapore",
      postalCode: "408734",
      addressCountry: "SG",
    },
    areaServed: [
      ...SELF_RUN_MARKETS.map((name) => ({ "@type": "Country", name })),
      ...PARTNER_MARKETS.map((name) => ({ "@type": "Country", name })),
    ],
    knowsAbout: [
      "Ecommerce fulfillment",
      "3PL warehousing",
      "4PL logistics coordination",
      "Cross-border freight",
      "Last-mile distribution",
      "B2B and B2C order fulfillment",
      "Merchant of Record services",
      "Importer of Record services",
    ],
    sameAs: [],
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}

export function ServiceJsonLd({
  services,
}: {
  services: { name: string; summary: string; slug: string }[];
}) {
  const data = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: services.map((service, i) => ({
      "@type": "Service",
      position: i + 1,
      name: service.name,
      description: service.summary,
      url: `${SITE_URL}/services#${service.slug}`,
      provider: { "@id": `${SITE_URL}/#organization` },
      areaServed: [
        ...SELF_RUN_MARKETS.map((name) => ({ "@type": "Country", name })),
        ...PARTNER_MARKETS.map((name) => ({ "@type": "Country", name })),
      ],
    })),
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}

export function FaqJsonLd({ faqs }: { faqs: { q: string; a: string }[] }) {
  const data = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((faq) => ({
      "@type": "Question",
      name: faq.q,
      acceptedAnswer: {
        "@type": "Answer",
        text: faq.a,
      },
    })),
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}
