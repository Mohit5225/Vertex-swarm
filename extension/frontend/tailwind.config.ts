import typography from '@tailwindcss/typography'

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        'vs-bg': '#1e1e1e',
        'vs-bg-light': '#252526',
        'vs-fg': '#d4d4d4',
        'vs-muted': '#A6A6A6',
        'vs-accent': '#007acc',
        'vs-success': '#4ec9b0',
        'vs-warning': '#dcdcaa',
        'vs-error': '#f48771',
        'vs-border': '#3e3e42',
        'vs-hover': '#2a2d2e',
      },
      fontFamily: {
        mono: ['Consolas', 'Monaco', 'Andale Mono', 'monospace'],
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      typography: {
        DEFAULT: {
          css: {
            color: '#d4d4d4',
            a: { color: '#3794ff', textDecoration: 'none', '&:hover': { textDecoration: 'underline' } },
            code: {
              color: '#dcdcaa',
              backgroundColor: '#2d2d2d',
              padding: '0.2em 0.4em',
              borderRadius: '3px',
              fontWeight: '400',
            },
            'code::before': { content: '""' },
            'code::after': { content: '""' },
            pre: {
              backgroundColor: '#1e1e1e',
              color: '#d4d4d4',
              borderRadius: '6px',
              border: '1px solid #3e3e42',
              margin: '0.5em 0',
            },
            p: { marginTop: '0.5em', marginBottom: '0.5em' },
            h1: { color: '#fff', fontSize: '1.2em', marginTop: '1em', marginBottom: '0.5em' },
            h2: { color: '#fff', fontSize: '1.1em', marginTop: '1em', marginBottom: '0.5em' },
            h3: { color: '#fff', fontSize: '1em', marginTop: '1em', marginBottom: '0.5em' },
            strong: { color: '#fff' },
            ul: { marginTop: '0.5em', marginBottom: '0.5em' },
            ol: { marginTop: '0.5em', marginBottom: '0.5em' },
            li: { marginTop: '0.25em', marginBottom: '0.25em' },
            blockquote: { borderLeftColor: '#3e3e42', color: '#A6A6A6' },
          },
        },
      },
      animation: {
        shimmer: 'shimmer 2.5s linear infinite',
        'border-spin': 'border-spin 4s linear infinite',
        'fade-up': 'fade-up 0.4s ease forwards',
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
      },
      keyframes: {
        shimmer: {
          '0%': { backgroundPosition: '-500px 0' },
          to: { backgroundPosition: '500px 0' },
        },
        'border-spin': {
          to: { transform: 'rotate(360deg)' },
        },
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'pulse-glow': {
          '0%, to': { boxShadow: '0 0 #007acc00' },
          '50%': { boxShadow: '0 0 20px 4px #007acc59' },
        },
      },
    },
  },
  plugins: [typography],
}
