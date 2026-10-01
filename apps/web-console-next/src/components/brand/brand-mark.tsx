import * as React from "react";
import { cn } from "@/lib/cn";

/**
 * The Arcdesk mark: a gable roofline over an arched door.
 *
 * Drawn on a 24×24 grid in `currentColor`, so it takes the colour of the
 * badge it sits in (`text-primary-foreground` on `bg-primary`).
 * `src/app/icon.svg` is the same mark with fixed colours, because a favicon
 * can't read CSS variables.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn("h-5 w-5", className)}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 11.5L12 4l9 7.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9 20v-4.5a3 3 0 0 1 6 0V20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 20h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
