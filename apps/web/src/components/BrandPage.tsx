// Not-found and error pages: the brand watermark behind a short message.
import type { ReactNode } from "react";
import { BehestWatermark } from "./BehestLoader";
import { Mark, SiteHeader } from "./chrome";

export function BrandPage({ code, title, body, children }: { code: string; title: string; body: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main id="main" className="relative flex flex-1 items-center overflow-hidden">
        <BehestWatermark className="absolute left-1/2 top-1/2 w-[min(720px,120vw)] -translate-x-1/2 -translate-y-1/2" />
        <div className="relative mx-auto flex max-w-[560px] flex-col items-center gap-5 px-4 py-24 text-center">
          <Mark size={44} />
          <span className="font-mono text-sm text-muted">{code}</span>
          <h1 className="text-[clamp(30px,5vw,44px)] font-medium leading-[1.05] tracking-[-0.035em]">{title}</h1>
          <p className="text-[17px] leading-relaxed text-muted">{body}</p>
          {children && <div className="flex flex-wrap justify-center gap-2 pt-2">{children}</div>}
        </div>
      </main>
    </div>
  );
}
