/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow the dashboard to import from workspace packages
  transpilePackages: ["@agentswap/shared", "@agentswap/agents", "@agentswap/lightning", "@agentswap/ethereum"],
  experimental: {
    // Required for streaming API routes in App Router
    serverActions: { allowedOrigins: ["localhost:3000"] },
  },
};

module.exports = nextConfig;
