export function Marquee({ items }: { items: string[] }) {
  const row = [...items, ...items];
  return (
    <div className="marquee" aria-hidden="true">
      <div className="marquee-track">
        {row.map((x, i) => (
          <span className="mq-item" key={i}>
            <span className="mq-dot" />
            {x}
          </span>
        ))}
      </div>
    </div>
  );
}
