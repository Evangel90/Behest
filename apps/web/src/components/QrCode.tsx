"use client";
// A QR code as one SVG path in currentColor (crisp at any size, no canvas).
import { useMemo } from "react";
import { encode } from "uqr";

export function QrCode({ value, label, className }: { value: string; label: string; className?: string }) {
  const { size, d } = useMemo(() => {
    const qr = encode(value, { ecc: "M", border: 0 });
    let path = "";
    qr.data.forEach((row, y) =>
      row.forEach((on, x) => {
        if (on) path += `M${x} ${y}h1v1h-1z`;
      }),
    );
    return { size: qr.size, d: path };
  }, [value]);
  return (
    <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} className={className} shapeRendering="crispEdges">
      <path d={d} fill="currentColor" />
    </svg>
  );
}
