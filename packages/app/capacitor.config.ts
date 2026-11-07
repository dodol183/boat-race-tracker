import type { CapacitorConfig } from '@capacitor/cli';

// The Android app: the same pages as the website, packaged with the phone's Bluetooth and a
// background GPS service. Build the pages first (npm run build), then `npx cap sync android`.
const config: CapacitorConfig = {
  appId: 'org.boatracetracker.app',
  appName: 'Boat Race Tracker',
  webDir: 'dist',
  android: {
    // Keeps location updates coming after 5 minutes in the background (background-geolocation)
    useLegacyBridge: true,
  },
};

export default config;
