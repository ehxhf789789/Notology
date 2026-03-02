import { useEffect, useState } from 'react';
import { useSettingsStore } from '../../stores/zustand/settingsStore';
import { refreshActions } from '../../stores/zustand/refreshStore';
import { t } from '../../utils/i18n';

interface LoadingScreenProps {
  isLoading: boolean;
}

const SLOW_THRESHOLD_MS = 15_000; // Show skip option after 15 seconds

function LoadingScreen({ isLoading }: LoadingScreenProps) {
  const language = useSettingsStore(s => s.language);
  const [dots, setDots] = useState('');
  const [showSkip, setShowSkip] = useState(false);

  useEffect(() => {
    if (!isLoading) {
      setShowSkip(false);
      return;
    }

    const interval = setInterval(() => {
      setDots(prev => (prev.length >= 3 ? '' : prev + '.'));
    }, 500);

    const slowTimer = setTimeout(() => {
      setShowSkip(true);
    }, SLOW_THRESHOLD_MS);

    return () => {
      clearInterval(interval);
      clearTimeout(slowTimer);
    };
  }, [isLoading]);

  if (!isLoading) return null;

  const handleSkip = () => {
    // Force searchReady to true so the app becomes usable (search may be degraded)
    refreshActions.setSearchReady(true);
  };

  return (
    <div className="loading-screen">
      <div className="loading-content">
        <div className="loading-spinner"></div>
        <div className="loading-text">Notology</div>
        <div className="loading-status">{t('loadingVault', language)}{dots}</div>
        {showSkip && (
          <div className="loading-slow">
            <div className="loading-slow-text">{t('loadingSlow', language)}</div>
            <button className="loading-skip-btn" onClick={handleSkip}>
              {t('loadingSkip', language)}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default LoadingScreen;
