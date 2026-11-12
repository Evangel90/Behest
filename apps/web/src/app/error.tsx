"use client";
import { House, RotateCcw } from "lucide-react";
import { BrandPage } from "@/components/BrandPage";
import { Button, ButtonLink } from "@/components/ui";

// Any page that crashes: nothing on-chain is affected, so say so and offer a retry.
export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <BrandPage code="Something broke" title="This page hit a problem." body="It's only the display. Plans, funds and check-ins live on-chain and aren't affected. Try again, or start from home.">
      <Button variant="ink" icon={RotateCcw} onClick={reset}>
        Try again
      </Button>
      <ButtonLink href="/" variant="outline" icon={House}>
        Home
      </ButtonLink>
    </BrandPage>
  );
}
