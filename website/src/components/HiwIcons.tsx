// Inline stroke-SVG glyphs for the How It Works page.
// All use currentColor + a uniform 1.5px stroke so they theme automatically.

export type IconName =
  | 'radar'
  | 'shield'
  | 'scale'
  | 'flame'
  | 'brain'
  | 'bolt'
  | 'ghost'
  | 'ladder'
  | 'layers'
  | 'monitor';

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
}

const paths: Record<IconName, React.ReactNode> = {
  radar: (
    <>
      <path d="M12 12 L20 7" />
      <path d="M12 4a8 8 0 1 0 8 8" />
      <path d="M12 8a4 4 0 1 0 4 4" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3 4 6v6c0 4.4 3.3 7.6 8 9 4.7-1.4 8-4.6 8-9V6l-8-3Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  scale: (
    <>
      <path d="M12 4v16" />
      <path d="M6 8h12" />
      <path d="M6 8 3 14a3 3 0 0 0 6 0L6 8Z" />
      <path d="M18 8l-3 6a3 3 0 0 0 6 0l-3-6Z" />
      <path d="M8 20h8" />
    </>
  ),
  flame: (
    <>
      <path d="M12 3c0 3-3 4-3 7a3 3 0 0 0 6 0c0-1-.5-2-1-2.5" />
      <path d="M12 21a6 6 0 0 0 6-6c0-4-3-6-4-9-2 2.5-3 4-5 5.5S6 14 6 16a6 6 0 0 0 6 5Z" />
    </>
  ),
  brain: (
    <>
      <path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-1 5 3 3 0 0 0 2 5 3 3 0 0 0 3 2V4Z" />
      <path d="M15 4a3 3 0 0 1 3 3 3 3 0 0 1 1 5 3 3 0 0 1-2 5 3 3 0 0 1-3 2V4Z" />
      <path d="M12 4v15" />
    </>
  ),
  bolt: (
    <>
      <path d="M13 3 4 14h6l-1 7 9-11h-6l1-7Z" />
    </>
  ),
  ghost: (
    <>
      <path d="M5 20V11a7 7 0 0 1 14 0v9l-2.5-1.5L14 20l-2-1.5L10 20l-2.5-1.5L5 20Z" />
      <circle cx="9.5" cy="10" r="1" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="10" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  ladder: (
    <>
      <path d="M7 21V4" />
      <path d="M17 21V4" />
      <path d="M7 8h10" />
      <path d="M7 12h10" />
      <path d="M7 16h10" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3 9 5-9 5-9-5 9-5Z" />
      <path d="m3 13 9 5 9-5" />
    </>
  ),
  monitor: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8" />
      <path d="M12 16v4" />
      <path d="m7 11 2.5-3 2 2.5L14 7l3 4" />
    </>
  ),
};

export function HiwIcon({ name, size = 24, className }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}
