/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        sema: '#5BBFE8',
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
};
