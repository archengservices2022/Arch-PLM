import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // WP-2A (2A-5): the app never uses next/image, so the built-in image
  // optimization endpoint (/_next/image) is switched off to remove an unused
  // attack surface (several Next.js advisories targeted it).
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
