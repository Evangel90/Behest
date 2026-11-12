import { House, Search } from "lucide-react";
import { BrandPage } from "@/components/BrandPage";
import { ButtonLink } from "@/components/ui";

export default function NotFound() {
  return (
    <BrandPage code="404" title="Nothing was left here." body="This page doesn't exist, or it moved. Plans are always at /plan/ followed by the owner's account.">
      <ButtonLink href="/" variant="ink" icon={House}>
        Home
      </ButtonLink>
      <ButtonLink href="/inspect" variant="outline" icon={Search}>
        Find a plan
      </ButtonLink>
    </BrandPage>
  );
}
