"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { Check, ChevronLeft, ChevronRight, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { SOLUTIONS } from "@/data/solutions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";

const quoteSchema = z.object({
  services: z.array(z.string()).min(1, "Pick at least one service"),
  shipmentDetails: z.string().min(10, "Add a few details (10+ characters)"),
  originCountry: z.string().min(2, "Enter an origin"),
  destinationCountry: z.string().min(2, "Enter a destination"),
  monthlyVolume: z.string().min(1, "Choose an estimated volume"),
  fullName: z.string().min(2, "Enter your full name"),
  email: z.string().email("Enter a valid email address"),
  company: z.string().min(2, "Enter a company name"),
  phone: z.string().optional(),
});

type QuoteValues = z.infer<typeof quoteSchema>;

const STEPS = [
  { id: "services", title: "Services", fields: ["services"] as const },
  { id: "shipment", title: "Shipment details", fields: ["shipmentDetails"] as const },
  {
    id: "route",
    title: "Origin & destination",
    fields: ["originCountry", "destinationCountry"] as const,
  },
  { id: "volume", title: "Volume", fields: ["monthlyVolume"] as const },
  {
    id: "contact",
    title: "Contact info",
    fields: ["fullName", "email", "company", "phone"] as const,
  },
  { id: "review", title: "Review & submit", fields: [] as const },
];

const VOLUME_OPTIONS = [
  "Under 100 orders / month",
  "100–500 orders / month",
  "500–2,000 orders / month",
  "2,000–10,000 orders / month",
  "10,000+ orders / month",
];

export function QuoteForm() {
  const [step, setStep] = React.useState(0);
  const [direction, setDirection] = React.useState(1);
  const [submitted, setSubmitted] = React.useState(false);
  const [submittedValues, setSubmittedValues] = React.useState<QuoteValues | null>(null);
  const reduceMotion = useReducedMotion();

  const {
    register,
    handleSubmit,
    trigger,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<QuoteValues>({
    resolver: zodResolver(quoteSchema),
    defaultValues: {
      services: [],
      shipmentDetails: "",
      originCountry: "",
      destinationCountry: "",
      monthlyVolume: "",
      fullName: "",
      email: "",
      company: "",
      phone: "",
    },
    mode: "onTouched",
  });

  const selectedServices = watch("services");
  const values = watch();

  const toggleService = (slug: string) => {
    const next = selectedServices.includes(slug)
      ? selectedServices.filter((s) => s !== slug)
      : [...selectedServices, slug];
    setValue("services", next, { shouldValidate: true });
  };

  const goNext = async () => {
    const fields = STEPS[step].fields;
    const valid = fields.length === 0 ? true : await trigger(fields as never);
    if (valid) {
      setDirection(1);
      setStep((s) => Math.min(s + 1, STEPS.length - 1));
    }
  };

  const goBack = () => {
    setDirection(-1);
    setStep((s) => Math.max(s - 1, 0));
  };

  const onSubmit = async (data: QuoteValues) => {
    await new Promise((r) => setTimeout(r, 700));
    // Prototype only: logged locally here. In production this should post to
    // a real quoting API / CRM endpoint (see the note in the success state).
    console.log("[quote-form submission]", data);
    setSubmittedValues(data);
    setSubmitted(true);
  };

  if (submitted && submittedValues) {
    return (
      <div className="mx-auto max-w-2xl rounded-lg border border-border bg-paper-alt p-10 text-center">
        <CheckCircle2 className="mx-auto h-12 w-12 text-confirm" />
        <h2 className="mt-5 font-display text-3xl font-bold text-ink">Quote request received</h2>
        <p className="mt-3 text-ink-muted">
          Thanks, {submittedValues.fullName.split(" ")[0]} — someone from the desk will follow up
          at <span className="font-semibold text-ink">{submittedValues.email}</span> shortly.
        </p>
        <p className="mt-6 text-xs text-ink-muted/80">
          Prototype note: this submission was logged to the browser console only. Connect this
          form to a real email inbox, CRM, or quoting API before launch.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <ol className="mb-10 flex flex-wrap gap-x-2 gap-y-3">
        {STEPS.map((s, i) => (
          <li key={s.id} className="flex items-center gap-2">
            <span
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold",
                i < step
                  ? "bg-confirm text-white"
                  : i === step
                  ? "bg-brand text-white"
                  : "bg-paper-deep text-ink-muted"
              )}
            >
              {i < step ? <Check className="h-3.5 w-3.5" /> : i + 1}
            </span>
            <span className={cn("text-xs font-semibold", i === step ? "text-ink" : "text-ink-muted")}>
              {s.title}
            </span>
            {i < STEPS.length - 1 && <span className="ml-1 h-px w-4 bg-border-strong" />}
          </li>
        ))}
      </ol>

      <form onSubmit={handleSubmit(onSubmit)} noValidate>
        <div className="overflow-hidden rounded-lg border border-border bg-paper-alt p-8">
        <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={step}
          initial={{ opacity: 0, x: reduceMotion ? 0 : direction * 16 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: reduceMotion ? 0 : direction * -16 }}
          transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        >
          {step === 0 && (
            <fieldset>
              <legend className="font-display text-2xl font-bold text-ink">
                Which services do you need?
              </legend>
              <p className="mt-1 text-sm text-ink-muted">Select all that apply.</p>
              <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {SOLUTIONS.map((sol) => {
                  const checked = selectedServices.includes(sol.slug);
                  return (
                    <button
                      type="button"
                      key={sol.slug}
                      onClick={() => toggleService(sol.slug)}
                      aria-pressed={checked}
                      className={cn(
                        "flex items-center gap-3 rounded-sm border px-4 py-3 text-left text-sm font-semibold transition-[color,background-color,border-color,transform] duration-150 ease-out active:scale-[0.98] motion-reduce:active:scale-100",
                        checked
                          ? "border-brand bg-brand-tint text-brand"
                          : "border-border-strong bg-paper text-ink hover:border-brand"
                      )}
                    >
                      <span
                        className={cn(
                          "flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] border",
                          checked ? "border-brand bg-brand text-white" : "border-border-strong"
                        )}
                      >
                        {checked && <Check className="h-3 w-3" />}
                      </span>
                      {sol.name}
                    </button>
                  );
                })}
              </div>
              {errors.services && <p className="mt-3 text-xs text-signal">{errors.services.message}</p>}
            </fieldset>
          )}

          {step === 1 && (
            <div>
              <h2 className="font-display text-2xl font-bold text-ink">Tell us about the shipment or storage need</h2>
              <p className="mt-1 text-sm text-ink-muted">
                SKU count, unit sizes, seasonality, anything relevant.
              </p>
              <Textarea
                className="mt-6"
                rows={6}
                placeholder="e.g. ~120 SKUs, mostly small cartons, strong Nov–Dec seasonal spike…"
                {...register("shipmentDetails")}
              />
              {errors.shipmentDetails && (
                <p className="mt-2 text-xs text-signal">{errors.shipmentDetails.message}</p>
              )}
            </div>
          )}

          {step === 2 && (
            <div>
              <h2 className="font-display text-2xl font-bold text-ink">Origin & destination</h2>
              <p className="mt-1 text-sm text-ink-muted">Where does stock come from, and where does it need to go?</p>
              <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2">
                <div>
                  <Label htmlFor="originCountry">Origin (country / port)</Label>
                  <Input id="originCountry" className="mt-1.5" {...register("originCountry")} />
                  {errors.originCountry && (
                    <p className="mt-1 text-xs text-signal">{errors.originCountry.message}</p>
                  )}
                </div>
                <div>
                  <Label htmlFor="destinationCountry">Destination market(s)</Label>
                  <Input id="destinationCountry" className="mt-1.5" {...register("destinationCountry")} />
                  {errors.destinationCountry && (
                    <p className="mt-1 text-xs text-signal">{errors.destinationCountry.message}</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {step === 3 && (
            <div>
              <h2 className="font-display text-2xl font-bold text-ink">Estimated monthly volume</h2>
              <p className="mt-1 text-sm text-ink-muted">A rough figure is fine — this only shapes the quote.</p>
              <div className="mt-6 max-w-sm">
                <Label htmlFor="monthlyVolume">Monthly order volume</Label>
                <Select
                  value={values.monthlyVolume}
                  onValueChange={(v) => setValue("monthlyVolume", v, { shouldValidate: true })}
                >
                  <SelectTrigger id="monthlyVolume" className="mt-1.5">
                    <SelectValue placeholder="Choose a range" />
                  </SelectTrigger>
                  <SelectContent>
                    {VOLUME_OPTIONS.map((opt) => (
                      <SelectItem key={opt} value={opt}>
                        {opt}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {errors.monthlyVolume && (
                  <p className="mt-2 text-xs text-signal">{errors.monthlyVolume.message}</p>
                )}
              </div>
            </div>
          )}

          {step === 4 && (
            <div>
              <h2 className="font-display text-2xl font-bold text-ink">How should we reach you?</h2>
              <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2">
                <div>
                  <Label htmlFor="fullName">Full name</Label>
                  <Input id="fullName" className="mt-1.5" {...register("fullName")} />
                  {errors.fullName && <p className="mt-1 text-xs text-signal">{errors.fullName.message}</p>}
                </div>
                <div>
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" type="email" className="mt-1.5" {...register("email")} />
                  {errors.email && <p className="mt-1 text-xs text-signal">{errors.email.message}</p>}
                </div>
                <div>
                  <Label htmlFor="company">Company</Label>
                  <Input id="company" className="mt-1.5" {...register("company")} />
                  {errors.company && <p className="mt-1 text-xs text-signal">{errors.company.message}</p>}
                </div>
                <div>
                  <Label htmlFor="phone">Phone (optional)</Label>
                  <Input id="phone" className="mt-1.5" {...register("phone")} />
                </div>
              </div>
            </div>
          )}

          {step === 5 && (
            <div>
              <h2 className="font-display text-2xl font-bold text-ink">Review your request</h2>
              <dl className="mt-6 divide-y divide-border rounded-md border border-border bg-paper text-sm">
                <ReviewRow label="Services">
                  {values.services
                    .map((slug) => SOLUTIONS.find((s) => s.slug === slug)?.name ?? slug)
                    .join(", ")}
                </ReviewRow>
                <ReviewRow label="Shipment details">{values.shipmentDetails}</ReviewRow>
                <ReviewRow label="Origin">{values.originCountry}</ReviewRow>
                <ReviewRow label="Destination">{values.destinationCountry}</ReviewRow>
                <ReviewRow label="Monthly volume">{values.monthlyVolume}</ReviewRow>
                <ReviewRow label="Contact">
                  {values.fullName} · {values.email} · {values.company}
                  {values.phone ? ` · ${values.phone}` : ""}
                </ReviewRow>
              </dl>
              <p className="mt-6 text-xs leading-relaxed text-ink-muted">
                By submitting this form you consent to NimbusTrade Solutions Pte Ltd collecting
                and using the details above to respond to your enquiry, in accordance with our{" "}
                <a href="/privacy" className="font-semibold text-brand hover:underline">
                  Privacy Policy
                </a>
                . We do not sell your data or add you to marketing lists without separate consent.
              </p>
            </div>
          )}
        </motion.div>
        </AnimatePresence>
        </div>

        <div className="mt-6 flex items-center justify-between">
          <Button
            type="button"
            variant="outline"
            onClick={goBack}
            disabled={step === 0}
            className={cn(step === 0 && "invisible")}
          >
            <ChevronLeft className="h-4 w-4" /> Back
          </Button>

          {step < STEPS.length - 1 ? (
            <Button type="button" onClick={goNext}>
              Next <ChevronRight className="h-4 w-4" />
            </Button>
          ) : (
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Submitting…" : "Submit request"}
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}

function ReviewRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 px-4 py-3 sm:grid-cols-[160px_1fr] sm:gap-4">
      <dt className="text-xs font-bold uppercase tracking-wide text-ink-muted">{label}</dt>
      <dd className="text-ink break-words">{children || "—"}</dd>
    </div>
  );
}
