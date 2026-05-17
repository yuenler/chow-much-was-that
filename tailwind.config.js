/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      boxShadow: {
        soft: "0 18px 60px rgba(15, 23, 42, 0.08)",
        panel: "0 12px 34px rgba(15, 23, 42, 0.07)"
      }
    }
  },
  plugins: []
};
