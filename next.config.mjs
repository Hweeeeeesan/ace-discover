/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: ['192.168.4.36'],
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
        { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
      ],
    }];
  },
  experimental: {
    proxyClientMaxBodySize: '16mb',
  },
};

export default nextConfig;
