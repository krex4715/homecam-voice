import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",          // ✅ 이게 핵심 (Electron file:// 대응)
});
