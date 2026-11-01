import type { NextConfig } from 'next';

const config: NextConfig = {
  transpilePackages: ['@specide/schema'],
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination:
          (process.env.API_ORIGIN ?? 'http://127.0.0.1:4100') + '/:path*',
      },
    ];
  },
};
export default config;
