"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, inputClass } from "./ui";

export function InspectForm({ initial = "" }: { initial?: string }) {
  const router = useRouter();
  const [owner, setOwner] = useState(initial);
  return (
    <form
      role="search"
      className="flex w-full max-w-[520px] flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const id = owner.trim().toLowerCase();
        if (id) router.push(`/plan/${encodeURIComponent(id)}?view=inspect`);
      }}
    >
      <label htmlFor="inspect-owner" className="text-sm font-semibold">
        Inspect any plan by owner account
      </label>
      <div className="flex gap-2">
        <input id="inspect-owner" className={inputClass} placeholder="kemi.testnet" value={owner} onChange={(e) => setOwner(e.target.value)} autoComplete="off" spellCheck={false} />
        <Button type="submit" variant="outline">
          Inspect
        </Button>
      </div>
    </form>
  );
}
