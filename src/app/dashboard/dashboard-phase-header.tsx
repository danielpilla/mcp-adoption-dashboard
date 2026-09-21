export function DashboardPhaseHeader({
  id,
  number,
  label,
  question,
}: {
  id: string;
  number: string;
  label: string;
  question: string;
}) {
  return (
    <div className="dar-phase" id={id}>
      <span>
        {number} · {label}
      </span>
      <strong>{question}</strong>
      <i aria-hidden="true" />
    </div>
  );
}
