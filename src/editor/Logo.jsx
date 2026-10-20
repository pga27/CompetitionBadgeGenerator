// The app's logo: a competition badge on a lanyard, with a 3x3 cube face.
// Same drawing as public/favicon.svg (the browser tab icon).
const CUBE = ["#ffffff", "#facc15", "#ef4444", "#22c55e", "#ffffff", "#f97316", "#facc15", "#ef4444", "#ffffff"];

export default function Logo({ size = 24 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <path d="M17 1 L29 15 M47 1 L35 15" stroke="#1d4ed8" strokeWidth="5" strokeLinecap="round" fill="none" />
      <rect x="25" y="10" width="14" height="9" rx="2.5" fill="#94a3b8" />
      <rect x="11" y="16" width="42" height="46" rx="8" fill="#2563eb" />
      <rect x="26" y="20.5" width="12" height="3.5" rx="1.75" fill="#1e3a8a" />
      {CUBE.map((color, i) => (
        <rect key={i} x={21 + (i % 3) * 8} y={28 + Math.floor(i / 3) * 8} width="6" height="6" rx="1.2" fill={color} />
      ))}
      <rect x="19" y="54" width="26" height="3.5" rx="1.75" fill="#bfdbfe" />
    </svg>
  );
}
