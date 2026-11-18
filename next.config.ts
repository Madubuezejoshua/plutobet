import { existsSync } from "node:fs";
import { config as loadDotenv } from "dotenv";
import type { NextConfig } from "next";

if (process.env.NODE_ENV !== "production" && existsSync(".env")) {
  loadDotenv({ override: true });
}

for (const name of ["NEXTAUTH_URL", "NEXTAUTH_URL_INTERNAL"] as const) {
  const value = process.env[name]?.trim();
  if (value) {
    process.env[name] = value;
  } else {
    delete process.env[name];
  }
}

const devOriginHosts = new Set<string>([
  "**.run.app",
  "127.0.0.1",
  "localhost",
  "**.localhost",
]);

for (const name of ["NEXTAUTH_URL", "NEXTAUTH_URL_INTERNAL"] as const) {
  const raw = process.env[name];
  if (!raw) continue;
  try {
    const hostname = new URL(raw).hostname.toLowerCase();
    if (hostname) devOriginHosts.add(hostname);
  } catch {
    // Ignore invalid URL env values; auth validation handles them at runtime.
  }
}

const nextConfig: NextConfig = {
  poweredByHeader: false,
  allowedDevOrigins: [...devOriginHosts],
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "r2.thesportsdb.com",
        port: "",
        pathname: "/**",
      },
      {
        protocol: "https",
        hostname: "www.thesportsdb.com",
        port: "",
        pathname: "/**",
      },
      {
        protocol: "https",
        hostname: "a.espncdn.com",
        port: "",
        pathname: "/**",
      },
      {
        protocol: "https",
        hostname: "flagcdn.com",
        port: "",
        pathname: "/**",
      },
    ],
  },
};

export default nextConfig;
