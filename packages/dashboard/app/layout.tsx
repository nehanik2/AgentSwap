import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AgentSwap — Cross-chain AI Escrow",
  description: "Trustless atomic swaps negotiated by AI agents across Bitcoin Lightning and Ethereum.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}
