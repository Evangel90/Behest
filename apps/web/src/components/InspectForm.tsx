"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowRight, Clock, Search } from "lucide-react";
import { watched } from "@/lib/demo";
import { shortName } from "@/lib/plan";
import { looksLikeNearAccount } from "@/lib/wizard";
import { Button, cx } from "./ui";

/** Look up any plan by its owner's account; offers plans this browser opened before. */
export function InspectForm({ initial = "", recent = false }: { initial?: string; recent?: boolean }) {
  const router = useRouter();
  const [owner, setOwner] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [seen, setSeen] = useState<string[]>([]);
  useEffect(() => {
    if (recent) setSeen(watched().slice(-6).reverse());
  }, [recent]);
  const go = (id: string) => router.push(`/plan/${encodeURIComponent(id)}?view=inspect`);
  return (
    <form
      role="search"
      className="flex w-full max-w-[560px] flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const id = owner.trim().toLowerCase();
        if (!id) return setError("Enter the owner's NEAR account.");
        if (!looksLikeNearAccount(id)) return setError("That doesn't look like a NEAR account (e.g. kemi.testnet).");
        setError(null);
        go(id);
      }}
    >
      <label htmlFor="inspect-owner" className="text-sm font-semibold">
        Inspect any plan by owner account
      </label>
      <div className="flex gap-2">
        <div className={cx("flex min-h-12 min-w-0 flex-1 items-center gap-2 rounded-tile border bg-card px-3.5 focus-within:border-signal focus-within:ring-2 focus-within:ring-signal/30", error ? "border-error" : "border-line")}>
          <Search aria-hidden className="size-[18px] shrink-0 text-muted" />
          <input
            id="inspect-owner"
            className="min-w-0 flex-1 bg-transparent py-2 text-base outline-none"
            placeholder="kemi.testnet"
            value={owner}
            onChange={(e) => {
              setOwner(e.target.value);
              setError(null);
            }}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-invalid={!!error}
            aria-describedby={error ? "inspect-error" : undefined}
          />
        </div>
        <Button type="submit" variant="ink" iconRight={ArrowRight}>
          Inspect
        </Button>
      </div>
      {error && (
        <span id="inspect-error" role="alert" className="text-[13px] font-semibold text-error">
          {error}
        </span>
      )}
      {seen.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          <span className="flex items-center gap-1 text-xs text-muted">
            <Clock aria-hidden className="size-3.5" />
            Recent
          </span>
          {seen.map((o) => (
            <button key={o} type="button" onClick={() => go(o)} title={o} className="min-h-9 max-w-[180px] truncate rounded-full border border-line bg-card px-3 text-sm hover:bg-subtle">
              {shortName(o)}
            </button>
          ))}
        </div>
      )}
    </form>
  );
}
