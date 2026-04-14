interface FinanceChartPoint {
  label: string;
  valueA: number;
  valueB: number;
}

interface FinanceChartProps {
  title: string;
  legendA: string;
  legendB: string;
  points: FinanceChartPoint[];
}

export function FinanceChart({ title, legendA, legendB, points }: FinanceChartProps) {
  const maxValue = Math.max(1, ...points.flatMap((point) => [point.valueA, point.valueB]));

  return (
    <article className="workspace-card workspace-card--span-2">
      <div className="workspace-chart-head">
        <h2 className="workspace-card-title">{title}</h2>
        <div className="workspace-chart-legend" aria-label="Chart legend">
          <span><i className="workspace-dot workspace-dot--a" />{legendA}</span>
          <span><i className="workspace-dot workspace-dot--b" />{legendB}</span>
        </div>
      </div>
      <div className="workspace-chart-grid">
        {points.map((point) => (
          <div key={point.label} className="workspace-chart-col">
            <div className="workspace-chart-bars">
              <span
                className="workspace-chart-bar workspace-chart-bar--a"
                style={{ height: `${(point.valueA / maxValue) * 100}%` }}
              />
              <span
                className="workspace-chart-bar workspace-chart-bar--b"
                style={{ height: `${(point.valueB / maxValue) * 100}%` }}
              />
            </div>
            <p className="workspace-chart-label">{point.label}</p>
          </div>
        ))}
      </div>
    </article>
  );
}
