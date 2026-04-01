/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans:    ['var(--font-sans)',    'system-ui', 'sans-serif'],
        display: ['var(--font-display)', 'system-ui', 'sans-serif'],
        mono:    ['var(--font-mono)',    'monospace'],
      },
      colors: {
        /* Semantic tokens driven by CSS variables (see globals.css) */
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        muted:       { DEFAULT: 'var(--muted)',       foreground: 'var(--muted-foreground)' },
        card:        { DEFAULT: 'var(--card)',         foreground: 'var(--card-foreground)' },
        border:      'var(--border)',
        input:       'var(--input)',
        ring:        'var(--ring)',
        primary:     { DEFAULT: 'var(--primary)',     foreground: 'var(--primary-foreground)' },
        secondary:   { DEFAULT: 'var(--secondary)',   foreground: 'var(--secondary-foreground)' },
        accent:      { DEFAULT: 'var(--accent)',      foreground: 'var(--accent-foreground)' },
        destructive: { DEFAULT: 'var(--destructive)', foreground: 'var(--destructive-foreground)' },
        success:     { DEFAULT: 'var(--success)',     foreground: 'var(--success-foreground)' },
        warning:     { DEFAULT: 'var(--warning)',     foreground: 'var(--warning-foreground)' },
        sidebar: {
          bg:          'var(--sidebar-bg)',
          foreground:  'var(--sidebar-foreground)',
          border:      'var(--sidebar-border)',
          active:      'var(--sidebar-active)',
          'active-bg': 'var(--sidebar-active-bg)',
          muted:       'var(--sidebar-muted)',
        },
      },
      borderRadius: {
        DEFAULT: '8px',
        lg: '12px',
        xl: '16px',
        '2xl': '20px',
      },
      boxShadow: {
        card:     '0 1px 3px 0 rgba(0,0,0,0.07), 0 1px 2px 0 rgba(0,0,0,0.05)',
        elevated: '0 4px 16px 0 rgba(0,0,0,0.12)',
        glow:     '0 0 20px var(--glow-color)',
      },
      keyframes: {
        'sonar-ping': {
          '0%':        { transform: 'scale(1)',   opacity: '0.55' },
          '70%':       {                          opacity: '0.1'  },
          '80%, 100%': { transform: 'scale(2.8)', opacity: '0'   },
        },
        'glow-breathe': {
          '0%, 100%': { opacity: '1'    },
          '50%':      { opacity: '0.35' },
        },
        'fade-in-up': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to:   { opacity: '1', transform: 'translateY(0)'   },
        },
      },
      animation: {
        'sonar-ping':    'sonar-ping 2.6s cubic-bezier(0,0,0.2,1) infinite',
        'glow-breathe':  'glow-breathe 2.2s ease-in-out infinite',
        'fade-in-up':    'fade-in-up 0.4s ease-out forwards',
      },
    },
  },
  plugins: [],
};
