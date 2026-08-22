"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Mail, Phone, MapPin, Clock, MessageCircle, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Reveal } from "@/components/reveal";

const contactSchema = z.object({
  name: z.string().min(2, "Enter your full name"),
  email: z.string().email("Enter a valid email address"),
  company: z.string().optional(),
  message: z.string().min(10, "Tell us a little more (10+ characters)"),
});

type ContactValues = z.infer<typeof contactSchema>;

const OFFICE_ADDRESS = "62 Ubi Road 1, Oxley Bizhub 2, #06-01, Singapore 408734";

export function ContactSection() {
  const [submitted, setSubmitted] = React.useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    reset,
  } = useForm<ContactValues>({ resolver: zodResolver(contactSchema) });

  const onSubmit = async (values: ContactValues) => {
    await new Promise((r) => setTimeout(r, 600));
    // Prototype only: logged locally. Wire this up to a real inbox / CRM endpoint before launch.
    console.log("[contact-form submission]", values);
    setSubmitted(true);
    reset();
  };

  return (
    <section className="mx-auto max-w-7xl px-6 py-24">
      <div className="grid grid-cols-1 gap-12 lg:grid-cols-[1fr_1.1fr]">
        <Reveal>
          <span className="text-xs font-bold uppercase tracking-wider text-brand">Contact</span>
          <h2 className="mt-3 font-display text-4xl font-bold text-ink">Talk to the desk.</h2>
          <p className="mt-4 max-w-md text-lg leading-relaxed text-ink-muted">
            Send a message here, or reach us directly through any of the channels below.
          </p>

          <div className="mt-8 space-y-4 text-sm">
            <a href="mailto:info@nimbustrade.co" className="flex items-center gap-3 text-ink hover:text-brand">
              <Mail className="h-5 w-5 text-brand" /> info@nimbustrade.co
            </a>
            <a href="tel:+6588776106" className="flex items-center gap-3 text-ink hover:text-brand">
              <Phone className="h-5 w-5 text-brand" /> +65 8877 6106
            </a>
            <a
              href="https://wa.me/6588776106"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 text-ink hover:text-brand"
            >
              <MessageCircle className="h-5 w-5 text-brand" /> WhatsApp the desk
            </a>
            <div className="flex items-center gap-3 text-ink">
              <MapPin className="h-5 w-5 shrink-0 text-brand" />
              {OFFICE_ADDRESS}
            </div>
            <div className="flex items-center gap-3 text-ink">
              <Clock className="h-5 w-5 text-brand" /> Mon–Fri, 9:00am–6:00pm SGT
            </div>
          </div>

          <div className="mt-8 h-64 overflow-hidden rounded-lg border border-border">
            <iframe
              title="NimbusTrade Solutions office location"
              src={`https://www.google.com/maps?q=${encodeURIComponent(OFFICE_ADDRESS)}&output=embed`}
              className="h-full w-full border-0"
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
            />
          </div>
        </Reveal>

        <Reveal delay={0.1} className="rounded-lg border border-border bg-paper-alt p-8">
          {submitted ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <CheckCircle2 className="h-10 w-10 text-confirm" />
              <h3 className="mt-4 font-display text-2xl font-bold text-ink">Message sent</h3>
              <p className="mt-2 max-w-sm text-sm text-ink-muted">
                Thanks — someone from the desk will get back to you shortly.
              </p>
              <Button variant="outline" className="mt-6" onClick={() => setSubmitted(false)}>
                Send another message
              </Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-5">
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <div>
                  <Label htmlFor="name">Full name</Label>
                  <Input id="name" className="mt-1.5" {...register("name")} />
                  {errors.name && <p className="mt-1 text-xs text-signal">{errors.name.message}</p>}
                </div>
                <div>
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" type="email" className="mt-1.5" {...register("email")} />
                  {errors.email && <p className="mt-1 text-xs text-signal">{errors.email.message}</p>}
                </div>
              </div>
              <div>
                <Label htmlFor="company">Company (optional)</Label>
                <Input id="company" className="mt-1.5" {...register("company")} />
              </div>
              <div>
                <Label htmlFor="message">Message</Label>
                <Textarea id="message" className="mt-1.5" rows={5} {...register("message")} />
                {errors.message && <p className="mt-1 text-xs text-signal">{errors.message.message}</p>}
              </div>
              <p className="text-xs leading-relaxed text-ink-muted">
                By submitting this form you consent to NimbusTrade Solutions Pte Ltd collecting
                and using the details above to respond to your enquiry, in accordance with our{" "}
                <a href="/privacy" className="font-semibold text-brand hover:underline">
                  Privacy Policy
                </a>
                . We do not sell your data or add you to marketing lists without separate consent.
              </p>
              <Button type="submit" className="w-full" disabled={isSubmitting}>
                {isSubmitting ? "Sending…" : "Send message"}
              </Button>
            </form>
          )}
        </Reveal>
      </div>
    </section>
  );
}
