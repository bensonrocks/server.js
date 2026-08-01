import type { Metadata } from "next";
import { SolutionsSelector } from "@/components/sections/solutions-selector";

export const metadata: Metadata = { title: "Solutions — NimbusTrade Solutions" };

export default function SolutionsPage() {
  return (
    <div className="pt-6">
      <SolutionsSelector />
    </div>
  );
}
