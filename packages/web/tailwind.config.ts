import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        canvas: '#f7f4ed',
        ink: '#1a1f2b',
        accent: '#0f766e',
        sun: '#f59e0b',
        danger: '#dc2626',
      },
      boxShadow: {
        card: '0 24px 60px -32px rgba(15, 23, 42, 0.35)',
      },
    },
  },
  plugins: [],
};

export default config;
