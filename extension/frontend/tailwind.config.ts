import typography from '@tailwindcss/typography'

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        'vs-bg': '#030303',
        'vs-bg-light': '#0c0c0c',
        'vs-fg': '#f5f0e6',
        'vs-muted': '#a39e94',
        'vs-accent': '#c9a962',
        'vs-accent-bright': '#e8d5a3',
        'vs-success': '#6db89a',
        'vs-warning': '#d4b87a',
        'vs-error': '#c4786a',
        'vs-border': 'rgba(255, 255, 255, 0.08)',
        'vs-hover': 'rgba(255, 255, 255, 0.06)',
      },
      fontFamily: {
        mono: ['Consolas', 'Monaco', 'Andale Mono', 'monospace'],
        sans: [
          'Segoe UI Variable Text',
          'Segoe UI',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
      },
      typography: {
        DEFAULT: {
          css: {
            color: '#f5f0e6',
            a: {
              color: '#c9a962',
              textDecoration: 'none',
              '&:hover': { textDecoration: 'underline' },
            },
            code: {
              color: '#e8d5a3',
              backgroundColor: 'rgba(255, 255, 255, 0.05)',
              padding: '0.2em 0.4em',
              borderRadius: '3px',
              fontWeight: '400',
            },
            'code::before': { content: '""' },
            'code::after': { content: '""' },
            pre: {
              backgroundColor: '#080808',
              color: '#f5f0e6',
              borderRadius: '6px',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              margin: '0.5em 0',
            },
            p: { marginTop: '0.5em', marginBottom: '0.5em' },
            h1: { color: '#ece8df', fontSize: '1.2em', marginTop: '1em', marginBottom: '0.5em' },
            h2: { color: '#ece8df', fontSize: '1.1em', marginTop: '1em', marginBottom: '0.5em' },
            h3: { color: '#ece8df', fontSize: '1em', marginTop: '1em', marginBottom: '0.5em' },
            strong: { color: '#ece8df' },
            ul: { marginTop: '0.5em', marginBottom: '0.5em' },
            ol: { marginTop: '0.5em', marginBottom: '0.5em' },
            li: { marginTop: '0.25em', marginBottom: '0.25em' },
            blockquote: { borderLeftColor: 'rgba(255, 255, 255, 0.08)', color: '#9a958c' },
          },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.4s ease forwards',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [typography],
}
