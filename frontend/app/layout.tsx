import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ADA Agentic Logistics Orchestrator",
  description: "GirlCode 2026 — Last-Mile Delivery AI",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@400;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}