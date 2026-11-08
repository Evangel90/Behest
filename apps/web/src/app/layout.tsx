import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import { SessionProvider } from "@/lib/session";
import "./globals.css";

const display = Space_Grotesk({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-space-grotesk" });
const sans = Inter({ subsets: ["latin"], variable: "--font-inter" });
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500", "700"], variable: "--font-jetbrains" });

export const metadata: Metadata = {
  title: "Behest — inheritance on NEAR",
  description: "Decide who receives your NEAR and Ethereum. If you stop checking in, guardians can start a release that only pays the addresses you chose.",
};

export const viewport: Viewport = { themeColor: "#F4F3EE", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body className="min-h-dvh bg-paper text-ink">
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
