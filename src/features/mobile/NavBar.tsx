/**
 * NavBar — iOS-style navigation bar with back button + title.
 */
import { ChevronLeft } from 'lucide-react';

interface NavBarProps {
  title: string;
  canGoBack: boolean;
  onBack: () => void;
  backLabel?: string;
}

export function NavBar({ title, canGoBack, onBack, backLabel }: NavBarProps) {
  return (
    <header className="mobile-navbar">
      <div className="mobile-navbar-left">
        {canGoBack && (
          <button className="mobile-navbar-back" onClick={onBack}>
            <ChevronLeft size={22} />
            {backLabel && <span className="mobile-navbar-back-label">{backLabel}</span>}
          </button>
        )}
      </div>
      <h1 className="mobile-navbar-title">{title}</h1>
      <div className="mobile-navbar-right" />
    </header>
  );
}
