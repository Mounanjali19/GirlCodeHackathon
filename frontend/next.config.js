/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow accessing the dev server from your LAN IP (prevents HMR being blocked).
  allowedDevOrigins: ["192.168.56.1"],
};

module.exports = nextConfig;

