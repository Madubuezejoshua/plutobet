import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "PlutoBet",
    template: "%s · PlutoBet",
  },
  description: "Sports betting, casino and games — with Pluto AI.",
};

export const viewport: Viewport = {
  // The dark chrome must extend into the iOS status bar and Android nav bar,
  // or the app frames itself in white on exactly the devices it targets.
  themeColor: "#080b12",
  width: "device-width",
  initialScale: 1,
  // Deliberately NOT locking zoom: pinch-to-zoom is an accessibility need, and
  // an odds table is precisely the sort of dense content people zoom into.
  maximumScale: 5,
};

/**
 * Root layout: document shell only.
 *
 * The player-facing chrome lives in `(site)/layout.tsx` and the admin chrome in
 * `admin/layout.tsx`, because the two must not share a navigation. An admin
 * looking at the exposure book should not be one tap from a betslip.
 */
export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
