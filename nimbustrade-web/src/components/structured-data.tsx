import { SITE_URL, SITE_NAME, SITE_DESCRIPTION } from "@/lib/site-config";

export function OrganizationJsonLd() {
  const data = {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": `${SITE_URL}/#organization`,
    name: SITE_NAME,
    alternateName: "云腾贸易方案私人有限公司",
    url: `${SITE_URL}/`,
    logo: `${SITE_URL}/logo.png`,
    image: `${SITE_URL}/og-image.png`,
    description: SITE_DESCRIPTION,
    email: "info@nimbustrade.co",
    telephone: "+65-8877-6106",
    areaServed: "Worldwide",
    knowsAbout: [
      "Ecommerce fulfillment",
      "Retail enablement in Singapore and Malaysia",
      "Worldwide ecommerce fulfillment, including the USA",
      "Regulatory compliance, including FDA",
      "Warehousing",
      "Freight forwarding",
      "Customs documentation",
    ],
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
      "@type": "ListItem",
      position: i + 1,
      item: {
        "@type": "Service",
        name: service.name,
        description: service.summary,
        url: `${SITE_URL}/services#${service.slug}`,
        provider: { "@id": `${SITE_URL}/#organization` },
        areaServed: "Worldwide",
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
