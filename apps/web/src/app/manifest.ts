import type { MetadataRoute } from "next";

// Installable app: the brand icons in public/brand.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Behest",
    short_name: "Behest",
    description: "Inheritance for Bitcoin, Ethereum and NEAR, coordinated by one public contract on NEAR. No custodian.",
    start_url: "/app",
    display: "standalone",
    background_color: "#0A0A0A",
    theme_color: "#0A0A0A",
    icons: [
      { src: "/brand/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/brand/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/brand/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/brand/behest-icon-dark.svg", sizes: "any", type: "image/svg+xml" },
    ],
  };
}
