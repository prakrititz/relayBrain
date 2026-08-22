import type { Metadata } from "next";
import "./globals.css";
import { RelayProvider } from "@/lib/RelayContext";

export const metadata: Metadata = {
  title: "./relay",
  description: "GitHub Desktop for AI agents",
  icons: {
    icon: "/logo_transparent.png",
    shortcut: "/logo_transparent.png",
    apple: "/logo.png",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <RelayProvider>{children}</RelayProvider>
      </body>
    </html>
  );
}
