export interface CaseStudy {
  slug: string;
  client: string;
  industry: string;
  isPlaceholder: boolean;
  challenge: string;
  solution: string;
  approach: string[];
  result: string;
}

// All entries below are illustrative placeholders — replace with confirmed
// client details, figures, and sign-off before this page goes live externally.
export const CASE_STUDIES: CaseStudy[] = [
  {
    slug: "placeholder-fashion-brand",
    client: "[ Client name — placeholder ]",
    industry: "Fashion & apparel",
    isPlaceholder: true,
    challenge:
      "[ Placeholder ] A growing apparel brand outgrew its founder-run storage room and needed fulfilment that could keep up with marketplace order volume during sales periods.",
    solution:
      "[ Placeholder ] Migrated storage and fulfilment onto NimbusTrade's warehouse network with a dedicated peak-season scaling plan.",
    approach: [
      "[ Placeholder ] Onboarded SKU catalogue and set up variant-level bin storage",
      "[ Placeholder ] Connected storefront and marketplace order feeds",
      "[ Placeholder ] Built a peak-day staffing and dispatch plan",
    ],
    result: "[ Placeholder — replace with a confirmed, client-approved outcome and figure. ]",
  },
  {
    slug: "placeholder-beauty-brand",
    client: "[ Client name — placeholder ]",
    industry: "Beauty & personal care",
    isPlaceholder: true,
    challenge:
      "[ Placeholder ] A beauty brand needed batch and expiry tracking their previous 3PL could not provide, ahead of an audit.",
    solution:
      "[ Placeholder ] Introduced batch/lot-level tracking and expiry reporting as part of standard receiving.",
    approach: [
      "[ Placeholder ] Reworked receiving process to capture batch and expiry on every inbound line",
      "[ Placeholder ] Set up expiry-ageing reports for the client's own review",
    ],
    result: "[ Placeholder — replace with a confirmed, client-approved outcome and figure. ]",
  },
  {
    slug: "placeholder-cross-border",
    client: "[ Client name — placeholder ]",
    industry: "Cross-border expansion",
    isPlaceholder: true,
    challenge:
      "[ Placeholder ] A Singapore-based seller wanted to start shipping into a neighbouring market without opening a local entity first.",
    solution:
      "[ Placeholder ] Routed orders through a cross-border lane with a local last-mile handoff partner.",
    approach: [
      "[ Placeholder ] Mapped landed cost and duty exposure before launch",
      "[ Placeholder ] Piloted with a limited SKU set before full rollout",
    ],
    result: "[ Placeholder — replace with a confirmed, client-approved outcome and figure. ]",
  },
];
