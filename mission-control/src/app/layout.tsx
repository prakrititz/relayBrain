import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { RelayProvider } from "@/lib/RelayContext";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: '--font-inter' });
const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], variable: '--font-mono' });

export const metadata: Metadata = {
  title: "/.relay - Shared Memory",
  description: "Shared Memory for AI Teams",
  icons: {
    icon: "/logos/logo.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${inter.variable} ${jetbrainsMono.variable}`}>
        <RelayProvider>
          {children}
        </RelayProvider>
      </body>
    </html>
  );
}
