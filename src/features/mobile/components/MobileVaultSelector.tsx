/**
 * MobileVaultSelector — placeholder.
 * v1 sync 기반 구현은 v1 레거시 정리(2026-05-04)와 함께 제거됨.
 * v2(connection module) 기반 모바일 vault selector는 Phase M-4b에서 재구현 예정.
 */
import { ArrowLeft } from 'lucide-react';

interface Props {
  onVaultSelected: (localPath: string, vaultName: string) => void;
  onBack: () => void;
  prefilledCreds?: {
    url: string;
    username: string;
    password: string;
  };
}

export function MobileVaultSelector({ onBack }: Props) {
  return (
    <div style={{
      padding: 24,
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
      height: '100%',
      background: 'var(--bg-1)',
    }}>
      <button
        onClick={onBack}
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--tx-2)',
          padding: 8,
          alignSelf: 'flex-start',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          cursor: 'pointer',
        }}
      >
        <ArrowLeft size={18} /> 뒤로
      </button>
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        textAlign: 'center',
        color: 'var(--tx-2)',
      }}>
        <h2 style={{ fontSize: 18, margin: 0 }}>모바일 보관소 선택</h2>
        <p style={{ fontSize: 14, color: 'var(--tx-3)', margin: 0 }}>
          이 기능은 다음 버전(M-4b)에서 재구현됩니다.
        </p>
        <p style={{ fontSize: 12, color: 'var(--tx-3)', margin: 0, lineHeight: 1.5 }}>
          데스크탑에서 보관소를 설정 후<br />
          동일 NAS로 자동 동기화됩니다.
        </p>
      </div>
    </div>
  );
}
