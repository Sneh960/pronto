import "./globals.css";

export const metadata = {
  title: "Pronto — the developer shutdown command",
  description:
    "One command that saves your open work, writes tomorrow's list, and pauses your coding agents until morning. A cure for compression burnout.",
  openGraph: {
    title: "Pronto — the developer shutdown command",
    description:
      "Save your open work, write tomorrow's list, pause your agents until morning.",
    type: "website",
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
