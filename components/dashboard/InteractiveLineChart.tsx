"use client";
import { useState } from "react";

interface Point {
  x: number;
  y: number;
  value: number;
  label: string;
}

export function InteractiveLineChart({
  points,
  color = "#22cf9d"
}: {
  points: { value: number; label: string }[];
  color?: string;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (!points || points.length === 0) return <div style={{ height: "100px", opacity: 0.5 }}>No data available</div>;

  // Normalize points to SVG space (0-100 x, 0-40 y)
  const W = 1000;
  const H = 200;
  const padding = 20;
  
  const minV = Math.min(...points.map((p) => p.value), 0);
  const maxV = Math.max(...points.map((p) => p.value), 1);
  const range = maxV - minV;

  const svgPoints: Point[] = points.map((p, i) => {
    const x = padding + (i / Math.max(1, (points.length - 1))) * (W - padding * 2);
    // Inverse Y so larger values are higher
    const y = H - padding - ((p.value - minV) / range) * (H - padding * 2);
    return { x, y, value: p.value, label: p.label };
  });

  // Calculate smooth bezier curve
  let d = `M ${svgPoints[0]?.x},${svgPoints[0]?.y}`;
  for (let i = 1; i < svgPoints.length; i++) {
    const pPrev = svgPoints[i - 1];
    const p = svgPoints[i];
    const cp1x = pPrev.x + (p.x - pPrev.x) / 2;
    const cp1y = pPrev.y;
    const cp2x = pPrev.x + (p.x - pPrev.x) / 2;
    const cp2y = p.y;
    d += ` C ${cp1x},${cp1y} ${cp2x},${cp2y} ${p.x},${p.y}`;
  }

  // Create area path under the curve
  const areaD = d + ` L ${svgPoints[svgPoints.length - 1]?.x},${H} L ${svgPoints[0]?.x},${H} Z`;

  return (
    <div style={{ position: "relative", width: "100%", height: "200px", fontFamily: "sans-serif" }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: "100%", overflow: "visible" }} onMouseLeave={() => setHoverIdx(null)}>
        
        <defs>
          <linearGradient id={`gradient-${color}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.2" />
            <stop offset="100%" stopColor={color} stopOpacity="0.0" />
          </linearGradient>
        </defs>

        {/* Area fill */}
        <path d={areaD} fill={`url(#gradient-${color})`} />

        {/* Line stroke */}
        <path d={d} fill="none" stroke={color} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />

        {/* Hover interaction overlay */}
        {svgPoints.map((p, i) => (
          <g key={i}>
            {/* Invisible wide circle for easy hovering */}
            <circle
              cx={p.x}
              cy={p.y}
              r={15}
              fill="transparent"
              style={{ cursor: "pointer" }}
              onMouseEnter={() => setHoverIdx(i)}
            />
            {/* Visible dot when hovered */}
            {hoverIdx === i && (
              <circle cx={p.x} cy={p.y} r={6} fill="#fff" stroke={color} strokeWidth="3" style={{ pointerEvents: "none" }} />
            )}
          </g>
        ))}
      </svg>

      {/* Hover tooltip HTML (absolute positioned) */}
      {hoverIdx !== null && (
        <div className="interactive-chart-tooltip" style={{
          position: "absolute",
          top: "10px", right: "20px",
          background: "#fff",
          border: "1px solid #eef0f8",
          boxShadow: "0 4px 15px rgba(0,0,0,0.06)",
          padding: "0.6rem 0.85rem",
          borderRadius: "0.6rem",
          pointerEvents: "none",
          minWidth: "120px"
        }}>
          <p style={{ margin: "0 0 0.15rem", fontSize: "0.75rem", color: "#6b7280", fontWeight: 600 }}>{svgPoints[hoverIdx]?.label}</p>
          <p style={{ margin: 0, fontSize: "1.1rem", fontWeight: 800, color: color }}>
            {svgPoints[hoverIdx]?.value.toFixed(2)} XLM
          </p>
        </div>
      )}

      <style jsx>{`
        @media (max-width: 640px) {
          .interactive-chart-tooltip {
            left: 12px;
            right: 12px;
            top: auto !important;
            bottom: 12px;
            min-width: 0 !important;
            width: auto;
          }
        }
      `}</style>
    </div>
  );
}
