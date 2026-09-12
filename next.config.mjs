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
    // Allows a 50 MiB source image plus multipart overhead to reach the
    // bounded Sharp normalizer. Stored profile images still have a 15 MiB
    // final limit.
    proxyClientMaxBodySize: '53mb',
  },
};

export default nextConfig;
