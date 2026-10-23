import type { JSX } from 'react';
import { Glyph } from '@/ui/components/Glyph';

export type TacticalTab = 'home' | 'send' | 'scan' | 'receive' | 'settings';

interface TacticalBottomNavProps {
  activeTab: TacticalTab;
  onSelectTab: (tab: TacticalTab) => void;
}

/**
 * Tactical bottom navigation bar matching the Veilpay mobile interface.
 * Features 5 tabs: [HOME], [SEND], floating amber [SCAN], [RECEIVE], [SETTINGS].
 */
export function TacticalBottomNav({
  activeTab,
  onSelectTab,
}: TacticalBottomNavProps): JSX.Element {
  return (
    <nav
      aria-label="Main Navigation"
      className="sticky bottom-0 z-40 mt-auto flex shrink-0 items-center justify-between border-t border-surface-600/80 bg-surface-800/95 dark:bg-surface-900/95 px-3 py-1.5 backdrop-blur-md"
    >
      {/* 1. HOME */}
      <button
        type="button"
        onClick={() => onSelectTab('home')}
        aria-label="Home tab"
        aria-current={activeTab === 'home' ? 'page' : undefined}
        className={`flex flex-1 flex-col items-center justify-center gap-1 py-1 transition-all duration-base ${
          activeTab === 'home'
            ? 'text-accent-500 font-semibold'
            : 'text-content-tertiary hover:text-content-secondary'
        }`}
      >
        <div
          className={`flex h-7 w-7 items-center justify-center rounded transition-colors ${
            activeTab === 'home'
              ? 'bg-neutral-900 text-white dark:bg-surface-700 dark:text-white shadow-sm'
              : 'bg-transparent text-content-tertiary'
          }`}
        >
          <Glyph name="home" className="h-4 w-4" />
        </div>
        <span
          className={`font-mono text-[9px] tracking-wider uppercase ${
            activeTab === 'home' ? 'font-bold text-accent-500' : 'text-content-tertiary'
          }`}
        >
          [HOME]
        </span>
      </button>

      {/* 2. SEND */}
      <button
        type="button"
        onClick={() => onSelectTab('send')}
        aria-label="Send tab"
        aria-current={activeTab === 'send' ? 'page' : undefined}
        className={`flex flex-1 flex-col items-center justify-center gap-1 py-1 transition-all duration-base ${
          activeTab === 'send'
            ? 'text-accent-500 font-semibold'
            : 'text-content-tertiary hover:text-content-secondary'
        }`}
      >
        <div
          className={`flex h-7 w-7 items-center justify-center rounded transition-colors ${
            activeTab === 'send'
              ? 'bg-neutral-900 text-white dark:bg-surface-700 dark:text-white shadow-sm'
              : 'bg-transparent text-content-tertiary'
          }`}
        >
          <Glyph name="send" className="h-4 w-4" />
        </div>
        <span
          className={`font-mono text-[9px] tracking-wider uppercase ${
            activeTab === 'send' ? 'font-bold text-accent-500' : 'text-content-tertiary'
          }`}
        >
          [SEND]
        </span>
      </button>

      {/* 3. CENTER FLOATING SCAN */}
      <div className="flex flex-1 flex-col items-center justify-center -mt-4">
        <button
          type="button"
          onClick={() => onSelectTab('scan')}
          aria-label="Scan QR"
          className="flex h-11 w-11 items-center justify-center rounded-lg bg-accent-500 text-white shadow-[0_4px_16px_rgba(245,158,11,0.55)] transition-transform duration-fast active:scale-90 hover:brightness-110"
        >
          <Glyph name="scan" className="h-6 w-6 stroke-[2] text-white" />
        </button>
        <span className="mt-1 font-mono text-[9px] font-bold tracking-wider text-accent-500 uppercase">
          [SCAN]
        </span>
      </div>

      {/* 4. RECEIVE */}
      <button
        type="button"
        onClick={() => onSelectTab('receive')}
        aria-label="Receive tab"
        aria-current={activeTab === 'receive' ? 'page' : undefined}
        className={`flex flex-1 flex-col items-center justify-center gap-1 py-1 transition-all duration-base ${
          activeTab === 'receive'
            ? 'text-accent-500 font-semibold'
            : 'text-content-tertiary hover:text-content-secondary'
        }`}
      >
        <div
          className={`flex h-7 w-7 items-center justify-center rounded transition-colors ${
            activeTab === 'receive'
              ? 'bg-neutral-900 text-white dark:bg-surface-700 dark:text-white shadow-sm'
              : 'bg-transparent text-content-tertiary'
          }`}
        >
          <Glyph name="receive" className="h-4 w-4" />
        </div>
        <span
          className={`font-mono text-[9px] tracking-wider uppercase ${
            activeTab === 'receive' ? 'font-bold text-accent-500' : 'text-content-tertiary'
          }`}
        >
          [RECEIVE]
        </span>
      </button>

      {/* 5. SETTINGS */}
      <button
        type="button"
        onClick={() => onSelectTab('settings')}
        aria-label="Settings tab"
        aria-current={activeTab === 'settings' ? 'page' : undefined}
        className={`flex flex-1 flex-col items-center justify-center gap-1 py-1 transition-all duration-base ${
          activeTab === 'settings'
            ? 'text-accent-500 font-semibold'
            : 'text-content-tertiary hover:text-content-secondary'
        }`}
      >
        <div
          className={`flex h-7 w-7 items-center justify-center rounded transition-colors ${
            activeTab === 'settings'
              ? 'bg-neutral-900 text-white dark:bg-surface-700 dark:text-white shadow-sm'
              : 'bg-transparent text-content-tertiary'
          }`}
        >
          <Glyph name="sun" className="h-4 w-4" />
        </div>
        <span
          className={`font-mono text-[9px] tracking-wider uppercase ${
            activeTab === 'settings' ? 'font-bold text-accent-500' : 'text-content-tertiary'
          }`}
        >
          [SETTINGS]
        </span>
      </button>
    </nav>
  );
}
