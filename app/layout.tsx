import type { Metadata } from "next";
import { IBM_Plex_Mono, Silkscreen } from "next/font/google";
import "./globals.css";

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex",
  weight: ["400", "500", "600"],
  subsets: ["latin"],
});

const silkscreen = Silkscreen({
  variable: "--font-pixel",
  weight: ["400", "700"],
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "CLAUDE//RELAY",
  description: "Local credential relay for Claude Code sessions",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${plexMono.variable} ${silkscreen.variable}`}>
      <body>
        <div className="crt" aria-hidden="true" />
        {children}
      </body>
    </html>
  );
}
