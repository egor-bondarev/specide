import type { Metadata } from 'next';
import { Providers } from '../components/providers';
import '@mdxeditor/editor/style.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'specIDE · Требования',
  description: 'Рабочая среда для требований и спецификаций',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ru">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
