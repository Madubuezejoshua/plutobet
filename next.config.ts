import type { NextConfig } from "next";

for (const name of ["NEXTAUTH_URL", "NEXTAUTH_URL_INTERNAL"] as const) {
  const value = process.env[name]?.trim();
  if (value) {
    process.env[name] = value;
  } else {
    delete process.env[name];
  }
}

const nextConfig: NextConfig = {
  poweredByHeader: false,
};

export default nextConfig;
