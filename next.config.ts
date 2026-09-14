import type { NextConfig } from "next";

const deployId =
  process.env.VERCEL_DEPLOYMENT_ID ||
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ||
  process.env.NEXT_PUBLIC_DEPLOY_ID ||
  (process.env.NODE_ENV === "production" ? Date.now().toString() : "development");

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_DEPLOY_ID: deployId,
  },
};

export default nextConfig;
