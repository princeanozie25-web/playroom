'use client';

import { useEffect, useState } from 'react';

export type PlayroomTheme = 'light' | 'dark';

export const PLAYROOM_THEME_STORAGE_KEY = 'playroom-landing-theme';

export function ThemeToggle({
  className = 'app-theme-toggle',
  showLabel = true,
}: {
  className?: string;
  showLabel?: boolean;
}) {
  const [theme, setTheme] = useState<PlayroomTheme>('light');

  useEffect(() => {
    setTheme(document.documentElement.dataset.landingTheme === 'dark' ? 'dark' : 'light');
  }, []);

  const nextTheme = theme === 'light' ? 'dark' : 'light';

  return (
    <button
      className={`theme-toggle ${className}`}
      type="button"
      aria-pressed={theme === 'dark'}
      aria-label={`Switch to ${nextTheme} theme`}
      onClick={() => {
        document.documentElement.dataset.landingTheme = nextTheme;
        window.localStorage.setItem(PLAYROOM_THEME_STORAGE_KEY, nextTheme);
        setTheme(nextTheme);
      }}
    >
      <svg className="theme-toggle__moon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M20.4 15.2A9 9 0 0 1 8.8 3.6 9 9 0 1 0 20.4 15.2Z" />
      </svg>
      <svg className="theme-toggle__sun" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="3.5" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
      {showLabel && <span>{nextTheme === 'dark' ? 'Dark' : 'Light'}</span>}
    </button>
  );
}
