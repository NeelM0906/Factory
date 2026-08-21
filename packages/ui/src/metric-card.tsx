export interface MetricCardProps {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly tone: "neutral" | "good" | "attention";
}

const TONE_LABELS: Record<MetricCardProps["tone"], string> = {
  neutral: "Baseline",
  good: "Healthy",
  attention: "Needs attention"
};

export function MetricCard({ label, value, detail, tone }: MetricCardProps) {
  return (
    <section
      className="as-metric"
      data-tone={tone}
      role="group"
      aria-label={`${label}: ${value}, ${detail}`}
    >
      <span className="as-metric__label">{label}</span>
      <strong className="as-metric__value">{value}</strong>
      <span className="as-metric__detail">{detail}</span>
      <span className="as-metric__tone">
        <span className="as-metric__signal" aria-hidden="true" />
        {TONE_LABELS[tone]}
      </span>
    </section>
  );
}
