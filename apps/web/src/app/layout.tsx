import type { Metadata, Viewport } from "next";
import { Figtree, Geist_Mono } from "next/font/google";
import { Providers } from "@/components/feedback";
import { SessionProvider } from "@/lib/session";
import "./globals.css";

const sans = Figtree({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-figtree" });
const mono = Geist_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-geist-mono" });

export const metadata: Metadata = {
  // Absolute URLs for the link-preview image; set NEXT_PUBLIC_SITE_URL in production.
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001"),
  title: "Behest — inheritance on NEAR",
  description: "Decide who receives your NEAR, Ethereum and Bitcoin, publicly or privately. If you stop checking in, guardians can start a release that only pays the addresses you chose.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FAFAFA" },
    { media: "(prefers-color-scheme: dark)", color: "#262626" },
  ],
  width: "device-width",
  initialScale: 1,
};

// Applies a saved light/dark choice before paint (no flash).
const THEME_SCRIPT = `try{var t=localStorage.getItem("behest-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-dvh bg-paper text-ink">
        <SessionProvider>
          <Providers>{children}</Providers>
        </SessionProvider>
      </body>
    </html>
  );
}
