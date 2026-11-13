import { ImageResponse } from "next/og";

// The link preview: the paper mark on brand blue (public/brand/behest-icon-blue.svg),
// with the landing headline.
export const alt = "Behest: everything you own, passed on exactly as you wish.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#2F62B5", color: "#FFFFFF", padding: 80, position: "relative", fontFamily: "sans-serif" }}>
        {/* The mark, large and faint, bleeding off the right edge. */}
        <svg width="640" height="640" viewBox="0 0 100 100" style={{ position: "absolute", right: -150, top: -40, opacity: 0.12 }}>
          <clipPath id="w">
            <circle cx="32" cy="32" r="32" />
          </clipPath>
          <circle cx="32" cy="32" r="32" fill="#FFFFFF" />
          <circle cx="60" cy="60" r="24" fill="#0A0A0A" clipPath="url(#w)" />
          <circle cx="60" cy="60" r="21" fill="none" stroke="#FFFFFF" strokeWidth="6" />
        </svg>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", width: "100%" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
            <svg width="72" height="72" viewBox="0 0 84 84">
              <clipPath id="m">
                <circle cx="32" cy="32" r="32" />
              </clipPath>
              <circle cx="32" cy="32" r="32" fill="#FFFFFF" />
              <circle cx="60" cy="60" r="24" fill="#2F62B5" clipPath="url(#m)" />
              <circle cx="60" cy="60" r="21" fill="none" stroke="#FFFFFF" strokeWidth="6" />
            </svg>
            <span style={{ fontSize: 48, fontWeight: 600, letterSpacing: -1.5 }}>behest</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
            <span style={{ fontSize: 76, fontWeight: 500, lineHeight: 1.04, maxWidth: 900 }}>Everything you own, passed on exactly as you wish.</span>
            <span style={{ fontSize: 30, opacity: 0.8 }}>A trustless inheritance protocol for Bitcoin, Ethereum and NEAR.</span>
          </div>
        </div>
      </div>
    ),
    size,
  );
}
