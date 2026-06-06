import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Disable PWA in dev mode to avoid caching issues
const isDev = process.env.NODE_ENV === 'development';

export default defineConfig({
  publicDir: 'public',
  server: {
    fs: {
      allow: ['..'], // Allow parent directory for symlink resolution
    },
  },
  resolve: {
    preserveSymlinks: true,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-antd': ['antd', '@ant-design/icons'],
          'vendor-charts': ['recharts'],
          'vendor-utils': ['zustand', 'fuse.js', 'i18next', 'react-i18next'],
        },
      },
    },
    // Improve chunk size warnings
    chunkSizeWarningLimit: 500,
  },
  plugins: [
    react(),
    VitePWA({
      // Disable service worker in dev mode to avoid caching issues
      devOptions: {
        enabled: false,
      },
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'icons/*.png'],
      manifest: {
        name: 'Araç Fiyat Listesi',
        short_name: 'Fiyat Listesi',
        description: 'Türkiye araç fiyat karşılaştırma ve analiz platformu',
        theme_color: '#000000',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          {
            src: 'icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Force immediate update and activation of new service worker
        skipWaiting: true,
        clientsClaim: true,
        // Clean old caches on activate
        cleanupOutdatedCaches: true,
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        runtimeCaching: [
          // IMPORTANT: Specific patterns MUST come before general patterns
          // Critical API endpoints - always fetch from network first
          {
            urlPattern: /\/api\/v1\/index(\?.*)?$/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'index-cache',
              networkTimeoutSeconds: 3,
              expiration: {
                maxEntries: 1,
                maxAgeSeconds: 60, // 1 minute - critical, always fresh
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
          {
            urlPattern: /\/api\/v1\/latest(\?.*)?$/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'latest-cache',
              networkTimeoutSeconds: 3,
              expiration: {
                maxEntries: 1,
                maxAgeSeconds: 60, // 1 minute
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
          {
            urlPattern: /\/api\/v1\/stats(\?.*)?$/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'stats-cache',
              networkTimeoutSeconds: 5,
              expiration: {
                maxEntries: 1,
                maxAgeSeconds: 60 * 15, // 15 minutes
              },
            },
          },
          {
            urlPattern: /\/api\/v1\/intel\/.*(\?.*)?$/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'intel-cache',
              networkTimeoutSeconds: 5,
              expiration: {
                maxEntries: 20,
                maxAgeSeconds: 60 * 15, // 15 minutes
              },
            },
          },
          // Vehicle data - NetworkFirst so today's (re)collected prices are never
          // served stale while online; cache is only a short-lived offline fallback.
          // (StaleWhileRevalidate showed yesterday's prices for the same date URL.)
          {
            urlPattern: /\/api\/v1\/vehicles\?.*$/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'vehicle-data-cache',
              networkTimeoutSeconds: 4,
              expiration: {
                maxEntries: 200,
                maxAgeSeconds: 60 * 60 * 24, // 1 day offline fallback
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
        ],
      },
    }),
  ],
  base: '/',
});
