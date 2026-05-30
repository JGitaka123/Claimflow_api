/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  experimental: {
    externalDir: true,
  },
  transpilePackages: ['@claimflow/shared'],
};

export default nextConfig;
