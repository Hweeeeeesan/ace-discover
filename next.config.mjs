/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: ['192.168.4.36'],
  experimental: {
    proxyClientMaxBodySize: '16mb',
  },
};

export default nextConfig;
