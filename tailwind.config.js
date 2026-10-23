import { colors, fonts, spacing, radii, motion } from './src/ui/theme/tokens.ts';

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./*.html', './src/**/*.{ts,tsx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        accent: colors.accent,
        /**
         * Semantic aliases.
         *
         * Surfaces were written against `accent-primary` / `error` / `surface-base`
         * before those names existed in the theme, so the classes compiled to
         * nothing: the active-tab highlight and every approval icon circle were
         * invisible, and error text rendered in the default colour. Defining the
         * names here repairs every existing usage at once and keeps the semantic
         * layer available for new work.
         */
        'accent-primary': colors.accent[500],
        'accent-secondary': colors.accent[400],
        surface: {
          900: 'rgb(var(--surface-900) / <alpha-value>)',
          800: 'rgb(var(--surface-800) / <alpha-value>)',
          700: 'rgb(var(--surface-700) / <alpha-value>)',
          600: 'rgb(var(--surface-600) / <alpha-value>)',
          500: 'rgb(var(--surface-500) / <alpha-value>)',
        },
        'surface-base': 'rgb(var(--surface-900) / <alpha-value>)',
        light: colors.light,
        content: {
          primary: 'rgb(var(--content-primary) / <alpha-value>)',
          secondary: 'rgb(var(--content-secondary) / <alpha-value>)',
          tertiary: 'rgb(var(--content-tertiary) / <alpha-value>)',
          inverse: 'rgb(var(--content-inverse) / <alpha-value>)',
        },
        success: colors.success,
        warning: colors.warning,
        danger: colors.danger,
        error: colors.danger,
        info: colors.info,
      },
      fontFamily: {
        display: fonts.display,
        body: fonts.body,
        mono: fonts.mono,
      },
      spacing,
      borderRadius: radii,
      transitionDuration: {
        fast: motion.fast,
        base: motion.base,
        slow: motion.slow,
      },
      boxShadow: {
        card: '0 1px 2px rgba(0, 0, 0, 0.3)',
        raised: '0 8px 24px -12px rgba(0, 0, 0, 0.6)',
        accent: '0 8px 24px -10px rgba(245, 158, 11, 0.5)',
      },
      transitionTimingFunction: {
        smooth: motion.ease,
        out: motion.easeOut,
        spring: motion.easeSpring,
      },
      /**
       * Entrance/attention animations.
       *
       * All use `both` fill mode so an element starts at its `from` state and
       * holds the `to` state, which keeps a delayed stagger from flashing the
       * un-animated position first. Durations stay short: the whole unlock →
       * dashboard reveal is under half a second.
       */
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'fade-in-up': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in-down': {
          from: { opacity: '0', transform: 'translateY(-8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'scale-in': {
          from: { opacity: '0', transform: 'scale(0.96)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        'pop-in': {
          from: { opacity: '0', transform: 'scale(0.8)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        'sheet-up': {
          from: { opacity: '0', transform: 'translateY(24px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        /* Wrong-passphrase feedback: a short, non-violent lateral shake. */
        shake: {
          '0%, 100%': { transform: 'translateX(0)' },
          '20%': { transform: 'translateX(-6px)' },
          '40%': { transform: 'translateX(6px)' },
          '60%': { transform: 'translateX(-4px)' },
          '80%': { transform: 'translateX(4px)' },
        },
        /* Expands and fades a ring outward — used behind the unlock mark. */
        'pulse-ring': {
          '0%': { opacity: '0.45', transform: 'scale(0.85)' },
          '100%': { opacity: '0', transform: 'scale(1.6)' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
      },
      animation: {
        'fade-in': `fade-in ${motion.base} ${motion.easeOut} both`,
        'fade-in-up': `fade-in-up ${motion.base} ${motion.easeOut} both`,
        'fade-in-down': `fade-in-down ${motion.base} ${motion.easeOut} both`,
        'scale-in': `scale-in ${motion.base} ${motion.easeOut} both`,
        'pop-in': `pop-in ${motion.slow} ${motion.easeSpring} both`,
        'sheet-up': `sheet-up ${motion.slow} ${motion.easeOut} both`,
        shake: 'shake 400ms cubic-bezier(0.36, 0.07, 0.19, 0.97) both',
        'pulse-ring': `pulse-ring ${motion.slower} ${motion.easeOut} both`,
        shimmer: 'shimmer 1.4s infinite',
      },
    },
  },
  plugins: [],
};
