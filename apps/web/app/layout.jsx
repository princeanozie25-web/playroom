import './globals.css';

export const metadata = {
  title: 'Playroom',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
