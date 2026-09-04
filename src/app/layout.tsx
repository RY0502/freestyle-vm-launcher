import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

function getMetadataBase() {
  const configuredUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();

  if (configuredUrl) return new URL(configuredUrl);
  if (vercelUrl) return new URL(`https://${vercelUrl}`);

  return new URL("http://localhost:3000");
}

export const metadata: Metadata = {
  metadataBase: getMetadataBase(),
  title: "Deepframe — Prompt to motion",
  description:
    "Wake a private creative studio and turn your next video prompt into motion.",
  openGraph: {
    title: "Deepframe — Prompt to motion",
    description:
      "Wake a private creative studio and turn your next video prompt into motion.",
    type: "website",
    images: [
      {
        url: "/og.png",
        width: 1731,
        height: 909,
        alt: "Deepframe — Your next story, set in motion.",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Deepframe — Prompt to motion",
    description:
      "Wake a private creative studio and turn your next video prompt into motion.",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
