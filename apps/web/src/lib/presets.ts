// Guided presets: named starting points for a new plan. A preset only fills
// in the wizard; every value stays editable before saving and on the plan
// page afterwards. They stay within the Free tier (3 guardians, claim mode),
// so picking one never makes a plan cost more.
import { UNIT_MS, fromMs, type TimerDraft } from "./wizard";

export type PresetId = "careful" | "balanced" | "quick";

export interface PresetValues {
  checkIn: number;
  grace: number;
  waiting: number;
  guardians: number;
  quorum: number;
  /** D28 edit notice; 0 = off. */
  notice: number;
  /** D29 availability window; 0 = off. */
  availability: number;
  swapDelay: number;
}

export interface Preset {
  id: PresetId;
  name: string;
  tagline: string;
  /** Who it suits, in one line. */
  forWhom: string;
  prod: PresetValues;
  demo: PresetValues;
}

const M = UNIT_MS.minutes;
const D = UNIT_MS.days;

export const PRESETS: Preset[] = [
  {
    id: "careful",
    name: "Careful",
    tagline: "Slow to start, hard to rush",
    forWhom: "For long trips or a large estate.",
    prod: { checkIn: 180 * D, grace: 30 * D, waiting: 30 * D, guardians: 3, quorum: 2, notice: 14 * D, availability: 180 * D, swapDelay: 14 * D },
    demo: { checkIn: 30 * M, grace: 5 * M, waiting: 10 * M, guardians: 3, quorum: 2, notice: 10 * M, availability: 30 * M, swapDelay: 10 * M },
  },
  {
    id: "balanced",
    name: "Balanced",
    tagline: "A sensible middle",
    forWhom: "Right for most people.",
    prod: { checkIn: 90 * D, grace: 14 * D, waiting: 14 * D, guardians: 3, quorum: 2, notice: 7 * D, availability: 90 * D, swapDelay: 7 * D },
    demo: { checkIn: 10 * M, grace: 2 * M, waiting: 5 * M, guardians: 3, quorum: 2, notice: 2 * M, availability: 10 * M, swapDelay: 2 * M },
  },
  {
    id: "quick",
    name: "Quick",
    tagline: "Heirs receive sooner",
    forWhom: "For frequent check-ins. Less time to catch a mistake.",
    prod: { checkIn: 30 * D, grace: 7 * D, waiting: 7 * D, guardians: 3, quorum: 2, notice: 1 * D, availability: 0, swapDelay: 3 * D },
    demo: { checkIn: 5 * M, grace: 0, waiting: 2 * M, guardians: 3, quorum: 2, notice: M, availability: 0, swapDelay: 2 * M },
  },
];

export const presetValues = (id: PresetId, demo: boolean): PresetValues => {
  const p = PRESETS.find((x) => x.id === id)!;
  return demo ? p.demo : p.prod;
};

/** The wizard fields a preset fills in. */
export interface PresetDraft {
  checkIn: TimerDraft;
  grace: TimerDraft;
  waiting: TimerDraft;
  guardians: string[];
  quorum: string;
  notice: number;
  availability: number;
  swapDelay: number;
}

/** Applies a preset, keeping guardians already typed in (and adding empty slots up to the preset's count). */
export function applyPreset<T extends PresetDraft>(d: T, id: PresetId, demo: boolean): T {
  const v = presetValues(id, demo);
  const guardians = [...d.guardians];
  while (guardians.length < v.guardians) guardians.push("");
  return {
    ...d,
    checkIn: fromMs(v.checkIn),
    grace: fromMs(v.grace),
    waiting: fromMs(v.waiting),
    guardians,
    quorum: String(v.quorum),
    notice: v.notice,
    availability: v.availability,
    swapDelay: v.swapDelay,
  };
}

/** Which preset values the draft no longer matches (empty: unchanged). */
export function editedFrom(d: { checkIn: number; grace: number; waiting: number; guardians: number; quorum: number; notice: number; availability: number; swapDelay: number }, id: PresetId, demo: boolean): (keyof PresetValues)[] {
  const v = presetValues(id, demo);
  return (Object.keys(v) as (keyof PresetValues)[]).filter((k) => (k === "swapDelay" ? d.availability > 0 && v[k] !== d[k] : v[k] !== d[k]));
}
