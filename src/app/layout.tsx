import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { JetBrains_Mono, Outfit, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

const plusJakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-sans",
  display: "swap",
});

const outfit = Outfit({
  subsets: ["latin"],
  weight: ["500", "600", "700", "800"],
  variable: "--font-display",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "PlutoBet",
    template: "%s · PlutoBet",
  },
  description: "Sports betting, live match center, casino and instant markets — with Pluto AI.",
  applicationName: "PlutoBet",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "PlutoBet",
  },
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/pwa-192x192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#090D1A",
  width: "device-width",
  initialScale: 1,
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
    <html
      lang="en"
      className={`dark ${plusJakarta.variable} ${outfit.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <body>{children}</body>
    </html>
  );
}
