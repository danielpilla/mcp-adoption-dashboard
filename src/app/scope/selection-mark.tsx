export function SelectionMark({ selected }: { selected: boolean }) {
  return (
    <span
      className={`chart-selection-mark${selected ? " selected" : ""}`}
      aria-hidden="true"
    >
      <span className="selection-add">+</span>
      <span className="selection-check">✓</span>
      <span className="selection-remove">×</span>
    </span>
  );
}
