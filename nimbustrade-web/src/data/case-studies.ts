export interface CaseStudy {
  slug: string;
  client: string;
  industry: string;
  challenge: string;
  solution: string;
  approach: string[];
  result: string;
}

// Client names are withheld by request — the outcomes below are real
// engagements, described generically rather than attributed by name.
export const CASE_STUDIES: CaseStudy[] = [
  {
    slug: "fashion-brand",
    client: "A fashion & apparel brand",
    industry: "Fashion & apparel",
    challenge:
      "A growing apparel brand outgrew its founder-run storage room and needed fulfilment that could keep up with marketplace order volume during sales periods.",
    solution:
      "Migrated storage and fulfilment onto NimbusTrade's appointed warehouse network with a dedicated peak-season scaling plan.",
    approach: [
      "Onboarded the SKU catalogue and set up variant-level bin storage",
      "Connected storefront and marketplace order feeds",
      "Built a peak-day staffing and dispatch plan",
    ],
    result: "Held same-day dispatch cut-offs through its largest sales period to date, with no backlog carried into the following day.",
  },
  {
    slug: "beauty-brand",
    client: "A beauty & personal care brand",
    industry: "Beauty & personal care",
    challenge:
      "A beauty brand needed batch and expiry tracking its previous 3PL could not provide, ahead of an audit.",
    solution:
      "Introduced batch/lot-level tracking and expiry reporting as part of standard receiving.",
    approach: [
      "Reworked the receiving process to capture batch and expiry on every inbound line",
      "Set up expiry-ageing reports for the client's own review",
    ],
    result: "Passed its audit with a full batch-and-expiry trail on hand, with no manual reconciliation required.",
  },
  {
    slug: "cross-border-expansion",
    client: "A Singapore-based cross-border seller",
    industry: "Cross-border expansion",
    challenge:
      "A Singapore-based seller wanted to start shipping into a neighbouring market without opening a local entity first.",
    solution:
      "Routed orders through a cross-border lane with a local last-mile handoff partner.",
    approach: [
      "Mapped landed cost and duty exposure before launch",
      "Piloted with a limited SKU set before full rollout",
    ],
    result: "Went live in the new market within the pilot's first quarter, ahead of setting up any local entity.",
  },
];
