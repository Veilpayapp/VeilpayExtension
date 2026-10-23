import type { JSX } from 'react';
import logoIcon from '@/ui/assets/icons/logo.png';

/**
 * Brand logo for in-app headers and cards. Renders the official Veilpay gold shield
 * logo PNG with a transparent background.
 */
export function BrandLogo({
  size = 'md',
  className = '',
}: {
  /** `md` for headers, `lg` for the welcome screen. */
  size?: 'md' | 'lg';
  className?: string;
}): JSX.Element {
  const dims = size === 'lg' ? 'h-16 w-16' : 'h-7 w-7';
  return (
    <img
      src={logoIcon}
      alt="Veilpay"
      className={`${dims} object-contain ${className}`}
    />
  );
}
