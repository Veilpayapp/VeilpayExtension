import { useEffect, useState, type JSX } from 'react';
import { getAddressBook, type AddressBookEntry } from '@/core/addressbook';
import { Glyph } from '@/ui/components/Glyph';
import { Button } from '@/ui/components/Button';
import type { ChainId } from '@/core/messaging/protocol';

interface AddressBookPickerProps {
  isOpen: boolean;
  /** Only entries for this chain are offered, so a picked address is valid
   *  for the transfer being composed. */
  chain: ChainId;
  onClose: () => void;
  /** Called with the chosen address. */
  onSelect: (address: string) => void;
}

function shortAddress(address: string): string {
  return address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/**
 * Address book picker for the send form.
 *
 * Backed by the real IndexedDB address book (shared with the options page) —
 * no placeholder/example addresses are ever injected into the recipient
 * field.
 */
export function AddressBookPicker({
  isOpen,
  chain,
  onClose,
  onSelect,
}: AddressBookPickerProps): JSX.Element | null {
  const [entries, setEntries] = useState<AddressBookEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    void getAddressBook()
      .then((all) => setEntries(all.filter((e) => e.chain === chain)))
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [isOpen, chain]);

  if (!isOpen) return null;

  const handleSelect = (address: string) => {
    onSelect(address);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label="Address Book"
    >
      <div className="w-full max-w-sm rounded-2xl border border-surface-600 bg-surface-900 p-4 shadow-raised flex flex-col gap-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Glyph name="card" className="h-5 w-5 text-accent-500" />
            <h3 className="font-display text-sm font-bold tracking-wider text-content-primary uppercase">
              ADDRESS BOOK
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close address book"
            className="text-content-tertiary hover:text-content-primary p-1 rounded-lg"
          >
            <Glyph name="x" className="h-4 w-4" />
          </button>
        </div>

        {/* Entry list for this chain */}
        {loading ? (
          <p className="font-mono text-xs text-content-tertiary text-center py-4">
            Loading saved addresses…
          </p>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <p className="font-mono text-xs text-content-secondary">
              No saved {chain.toUpperCase()} addresses yet.
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void chrome.runtime.openOptionsPage()}
            >
              Manage in Settings
            </Button>
          </div>
        ) : (
          <ul className="flex max-h-72 flex-col gap-1.5 overflow-y-auto">
            {entries.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  onClick={() => handleSelect(entry.address)}
                  className="flex w-full items-center justify-between rounded-xl border border-surface-700 bg-surface-800/80 px-3 py-2.5 text-left transition-colors hover:border-accent-500/50 hover:bg-surface-700 active:scale-[0.99]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-display text-sm font-bold text-white">
                      {entry.label}
                    </div>
                    <div className="truncate font-mono text-[10px] text-content-tertiary">
                      {shortAddress(entry.address)}
                      {entry.note !== undefined && entry.note.length > 0 ? ` · ${entry.note}` : ''}
                    </div>
                  </div>
                  <Glyph name="chevron-right" className="ml-2 h-4 w-4 shrink-0 text-accent-500" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <Button variant="secondary" onClick={onClose} fullWidth>
          Cancel
        </Button>
      </div>
    </div>
  );
}
