"use client";
// Keeps dashboards calm: long explanations start folded.
// MoreText: shows the first sentence of a long blurb, the rest behind "More".
// Explain: a "How this works" toggle around a help paragraph or list.
import { ChevronDown } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

const LONG = 110;

/** The first sentence, and the rest (empty when the text is short or one sentence). */
export function splitLead(text: string): [string, string] {
  if (text.length <= LONG) return [text, ""];
  const m = /^(.+?[.!?])\s+(\S.*)$/s.exec(text);
  return m ? [m[1]!, m[2]!] : [text, ""];
}

export function MoreText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const [lead, rest] = splitLead(text);
  if (!rest) return <>{text}</>;
  return (
    <>
      {lead}
      {open && <span id={id}> {rest}</span>}{" "}
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)} className="inline whitespace-nowrap font-semibold text-signal-text underline-offset-2 hover:underline">
        {open ? "Less" : "More"}
      </button>
    </>
  );
}

export function Explain({ label = "How this works", children, className }: { label?: string; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className={className}>
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)} className="inline-flex min-h-8 items-center gap-1 text-sm font-semibold text-muted hover:text-ink">
        {label}
        <ChevronDown aria-hidden className={`size-4 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div id={id} className="animate-fade-up pt-1 text-sm leading-relaxed text-muted">
          {children}
        </div>
      )}
    </div>
  );
}
