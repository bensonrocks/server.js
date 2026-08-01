import type { Metadata } from "next";
import { Industries } from "@/components/sections/industries";

export const metadata: Metadata = { title: "Industries — NimbusTrade Solutions" };

export default function IndustriesPage() {
  return (
    <div className="pt-6">
      <Industries />
    </div>
  );
}
