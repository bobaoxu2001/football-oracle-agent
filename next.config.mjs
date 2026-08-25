/** @type {import('next').NextConfig} */
const publicReadRoutes = [
  "/",
  "/accuracy",
  "/live",
  "/live/:path*",
  "/shadow",
  "/matches",
  "/match/:path*",
  "/api/live",
  "/api/live/:path*",
  "/api/accuracy",
  "/api/shadow",
  "/api/matches/upcoming",
];

const noStoreRoutes = [
  "/health",
  "/market",
  "/api/health",
  "/api/market",
  "/api/market/health",
  "/api/matches/:matchId/intelligence",
];

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async redirects() {
    return [
      {
        source: "/favicon.ico",
        destination: "/icon.svg",
        permanent: true,
      },
    ];
  },
  async headers() {
    return [
      ...publicReadRoutes.map((source) => ({
        source,
        headers: [
          {
            key: "Vercel-CDN-Cache-Control",
            value: "public, s-maxage=15, stale-while-revalidate=45, stale-if-error=120",
          },
        ],
      })),
      ...noStoreRoutes.map((source) => ({
        source,
        headers: [
          { key: "Cache-Control", value: "private, no-store" },
          { key: "Vercel-CDN-Cache-Control", value: "private, no-store" },
        ],
      })),
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
