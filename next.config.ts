import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'greedy-vole-262.convex.cloud',
        pathname: '/api/storage/**',
      },
    ],
  },
};

export default nextConfig;
