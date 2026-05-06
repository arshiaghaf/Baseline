import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        baseline: {
          bg: "#f5f3ee",
          ink: "#191816",
          muted: "#6f6a62",
          line: "#ded9cf",
          panel: "#fffdf8",
          accent: "#2563eb",
          good: "#15803d",
          warn: "#b45309",
          danger: "#b91c1c"
        }
      },
      boxShadow: {
        panel: "0 18px 60px rgba(33, 31, 27, 0.12)"
      }
    }
  },
  plugins: []
} satisfies Config;
