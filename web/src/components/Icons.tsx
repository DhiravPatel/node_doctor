import type { SVGProps } from "react";

const base = (props: SVGProps<SVGSVGElement>) => ({
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  ...props,
});

export const IconAsync = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M21 12a9 9 0 1 1-3-6.7" />
    <path d="M21 4v4h-4" />
  </svg>
);
export const IconBolt = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M13 2 4.5 13.5H11l-1 8.5L18.5 10H12l1-8Z" />
  </svg>
);
export const IconSpread = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="5" cy="12" r="2.4" />
    <circle cx="19" cy="5" r="2.4" />
    <circle cx="19" cy="12" r="2.4" />
    <circle cx="19" cy="19" r="2.4" />
    <path d="M7.4 11 16.6 6M7.4 12h9.2M7.4 13l9.2 5" />
  </svg>
);
export const IconInject = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="m18 2 4 4M17 3l4 4M18.5 6.5 8 17l-4 1 1-4L15.5 3.5" />
    <path d="m14 7 3 3M11 10l3 3" />
  </svg>
);
export const IconTarget = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="8" />
    <circle cx="12" cy="12" r="4" />
    <circle cx="12" cy="12" r="0.6" fill="currentColor" />
  </svg>
);
export const IconBranch = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="6" cy="5" r="2.2" />
    <circle cx="6" cy="19" r="2.2" />
    <circle cx="18" cy="8" r="2.2" />
    <path d="M6 7.2v9.6M6 12a6 6 0 0 0 6-6h4" />
  </svg>
);
export const IconGauge = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M4 20a8 8 0 1 1 16 0" />
    <path d="m12 14 4-4" />
    <circle cx="12" cy="14" r="1" fill="currentColor" />
  </svg>
);
export const IconRules = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M4 6h9M4 12h9M4 18h6" />
    <path d="m16 15 2 2 4-4" />
  </svg>
);
export const IconMerge = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="6" cy="6" r="2.2" />
    <circle cx="6" cy="18" r="2.2" />
    <circle cx="18" cy="12" r="2.2" />
    <path d="M6 8.2v7.6M6 9a6 6 0 0 0 6 3h3.8" />
  </svg>
);
export const IconAgent = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="5" y="8" width="14" height="10" rx="2.5" />
    <path d="M12 3v3M8.5 13h.01M15.5 13h.01M9 18v2M15 18v2M3 12h2M19 12h2" />
  </svg>
);
export const IconScan = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
    <path d="M4 12h16" />
  </svg>
);
export const IconWand = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M15 4V2M15 10V8M12 7h-2M20 7h-2M17.7 4.3l1.4-1.4M11.9 10.1l-1.4 1.4" />
    <path d="M4 20 13 11l1 1-9 9-1-1Z" />
  </svg>
);
export const IconArrow = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base({ width: 16, height: 16, ...p })}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);
