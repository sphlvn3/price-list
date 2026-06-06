// Global State Management with Zustand
// Manages favorites, comparison list, language, and theme

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import i18n from '../i18n';

// Types
export type Language = 'tr' | 'en';
export type Theme = 'light' | 'dark';

export interface VehicleIdentifier {
  brand: string;
  model: string;
  trim: string;
  engine: string;
  id: string; // Unique identifier: `${brand}-${model}-${trim}-${engine}`
}

// Tracked vehicle for price change notifications
export interface TrackedVehicle {
  id: string;
  brand: string;
  model: string;
  trim: string;
  engine: string;
  lastPrice: number;
  lastPriceRaw: string;
  lastCheckDate: string;
}

// Price change info
export interface PriceChange {
  vehicle: TrackedVehicle;
  oldPrice: number;
  newPrice: number;
  oldPriceRaw: string;
  newPriceRaw: string;
  diff: number;
  diffPercent: number;
}

// Alert Rule for Alerts v2
export interface AlertCondition {
  field: 'brand' | 'model' | 'price' | 'priceChange';
  operator: 'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte' | 'contains';
  value: string | number;
}

export interface AlertRule {
  id: string;
  name: string;
  enabled: boolean;
  conditions: AlertCondition[];
  createdAt: string;
}

export interface TriggeredAlert {
  ruleId: string;
  ruleName: string;
  vehicleId: string;
  vehicle: VehicleIdentifier;
  triggeredAt: string;
  reason: string;
}

// Segment mapping for Gap Finder
export interface SegmentMapping {
  keyword: string;
  segment: string;
}

interface AppState {
  // Favorites
  favorites: VehicleIdentifier[];
  addFavorite: (vehicle: VehicleIdentifier) => void;
  removeFavorite: (id: string) => void;
  isFavorite: (id: string) => boolean;
  clearFavorites: () => void;

  // Comparison (max 4 vehicles)
  compareList: VehicleIdentifier[];
  addToCompare: (vehicle: VehicleIdentifier) => boolean; // Returns false if max reached
  removeFromCompare: (id: string) => void;
  isInCompare: (id: string) => boolean;
  clearCompare: () => void;
  canAddToCompare: () => boolean;

  // Tracked vehicles (price change notifications)
  trackedVehicles: TrackedVehicle[];
  addTrackedVehicle: (vehicle: TrackedVehicle) => void;
  removeTrackedVehicle: (id: string) => void;
  updateTrackedVehicle: (id: string, price: number, priceRaw: string) => void;
  isTracked: (id: string) => boolean;
  clearTrackedVehicles: () => void;

  // Price changes (computed on app load)
  priceChanges: PriceChange[];
  setPriceChanges: (changes: PriceChange[]) => void;
  clearPriceChanges: () => void;
  priceChangesChecked: boolean;
  setPriceChangesChecked: (checked: boolean) => void;

  // Language
  language: Language;
  setLanguage: (lang: Language) => void;

  // Theme
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;

  // Loading screen
  hasSeenIntro: boolean;
  setHasSeenIntro: (seen: boolean) => void;

  // Price alerts (future feature)
  priceAlerts: Array<{
    vehicleId: string;
    targetPrice: number;
    createdAt: string;
  }>;
  addPriceAlert: (vehicleId: string, targetPrice: number) => void;
  removePriceAlert: (vehicleId: string) => void;

  // Intel Mode
  intelModeEnabled: boolean;
  setIntelModeEnabled: (enabled: boolean) => void;

  // Advanced Alerts v2
  alertRules: AlertRule[];
  addAlertRule: (rule: AlertRule) => void;
  removeAlertRule: (id: string) => void;
  updateAlertRule: (id: string, updates: Partial<AlertRule>) => void;
  triggeredAlerts: TriggeredAlert[];
  setTriggeredAlerts: (alerts: TriggeredAlert[]) => void;
  clearTriggeredAlerts: () => void;

  // Gap Finder - Segment Mappings
  customSegmentMappings: SegmentMapping[];
  setCustomSegmentMappings: (mappings: SegmentMapping[]) => void;
  addSegmentMapping: (mapping: SegmentMapping) => void;
  removeSegmentMapping: (keyword: string) => void;
}

// Maximum vehicles in comparison
const MAX_COMPARE_ITEMS = 4;

// Create vehicle ID from vehicle data
export const createVehicleId = (
  brand: string,
  model: string,
  trim: string,
  engine: string
): string => {
  // Handle undefined/empty values to prevent duplicate keys
  const safeBrand = brand || 'unknown';
  const safeModel = model || 'unknown';
  const safeTrim = trim || 'base';
  const safeEngine = engine || 'standard';
  return `${safeBrand}-${safeModel}-${safeTrim}-${safeEngine}`.toLowerCase().replace(/\s+/g, '-');
};

// Create VehicleIdentifier from row data
export const createVehicleIdentifier = (
  brand: string,
  model: string,
  trim: string,
  engine: string
): VehicleIdentifier => ({
  brand,
  model,
  trim,
  engine,
  id: createVehicleId(brand, model, trim, engine),
});

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      // Favorites
      favorites: [],

      addFavorite: (vehicle) => {
        const state = get();
        if (!state.favorites.find((f) => f.id === vehicle.id)) {
          set({ favorites: [...state.favorites, vehicle] });
        }
      },

      removeFavorite: (id) => {
        set({ favorites: get().favorites.filter((f) => f.id !== id) });
      },

      isFavorite: (id) => {
        return get().favorites.some((f) => f.id === id);
      },

      clearFavorites: () => {
        set({ favorites: [] });
      },

      // Comparison
      compareList: [],

      addToCompare: (vehicle) => {
        const state = get();
        if (state.compareList.length >= MAX_COMPARE_ITEMS) {
          return false;
        }
        if (!state.compareList.find((c) => c.id === vehicle.id)) {
          set({ compareList: [...state.compareList, vehicle] });
        }
        return true;
      },

      removeFromCompare: (id) => {
        set({ compareList: get().compareList.filter((c) => c.id !== id) });
      },

      isInCompare: (id) => {
        return get().compareList.some((c) => c.id === id);
      },

      clearCompare: () => {
        set({ compareList: [] });
      },

      canAddToCompare: () => {
        return get().compareList.length < MAX_COMPARE_ITEMS;
      },

      // Tracked vehicles
      trackedVehicles: [],

      addTrackedVehicle: (vehicle) => {
        const state = get();
        if (!state.trackedVehicles.find((t) => t.id === vehicle.id)) {
          set({ trackedVehicles: [...state.trackedVehicles, vehicle] });
        }
      },

      removeTrackedVehicle: (id) => {
        set({ trackedVehicles: get().trackedVehicles.filter((t) => t.id !== id) });
      },

      updateTrackedVehicle: (id, price, priceRaw) => {
        const state = get();
        const updated = state.trackedVehicles.map((t) =>
          t.id === id
            ? { ...t, lastPrice: price, lastPriceRaw: priceRaw, lastCheckDate: new Date().toISOString() }
            : t
        );
        set({ trackedVehicles: updated });
      },

      isTracked: (id) => {
        return get().trackedVehicles.some((t) => t.id === id);
      },

      clearTrackedVehicles: () => {
        set({ trackedVehicles: [] });
      },

      // Price changes
      priceChanges: [],

      setPriceChanges: (changes) => {
        set({ priceChanges: changes });
      },

      clearPriceChanges: () => {
        set({ priceChanges: [] });
      },

      priceChangesChecked: false,

      setPriceChangesChecked: (checked) => {
        set({ priceChangesChecked: checked });
      },

      // Language - wrapped in try-catch for private browsing mode
      language: (() => {
        try {
          return (localStorage.getItem('language') as Language) || 'tr';
        } catch {
          return 'tr';
        }
      })(),

      setLanguage: (lang) => {
        i18n.changeLanguage(lang);
        set({ language: lang });
      },

      // Theme
      theme: 'light',

      setTheme: (theme) => {
        set({ theme });
        // Apply theme to document
        document.documentElement.setAttribute('data-theme', theme);
        if (theme === 'dark') {
          document.documentElement.classList.add('dark');
        } else {
          document.documentElement.classList.remove('dark');
        }
      },

      toggleTheme: () => {
        const newTheme = get().theme === 'light' ? 'dark' : 'light';
        get().setTheme(newTheme);
      },

      // Loading screen
      hasSeenIntro: false,

      setHasSeenIntro: (seen) => {
        set({ hasSeenIntro: seen });
      },

      // Price alerts
      priceAlerts: [],

      addPriceAlert: (vehicleId, targetPrice) => {
        const state = get();
        if (!state.priceAlerts.find((a) => a.vehicleId === vehicleId)) {
          set({
            priceAlerts: [
              ...state.priceAlerts,
              {
                vehicleId,
                targetPrice,
                createdAt: new Date().toISOString(),
              },
            ],
          });
        }
      },

      removePriceAlert: (vehicleId) => {
        set({
          priceAlerts: get().priceAlerts.filter((a) => a.vehicleId !== vehicleId),
        });
      },

      // Intel Mode — on by default (not persisted, so it always starts enabled)
      intelModeEnabled: true,

      setIntelModeEnabled: (enabled) => {
        set({ intelModeEnabled: enabled });
      },

      // Advanced Alerts v2
      alertRules: [],

      addAlertRule: (rule) => {
        const state = get();
        if (!state.alertRules.find((r) => r.id === rule.id)) {
          set({ alertRules: [...state.alertRules, rule] });
        }
      },

      removeAlertRule: (id) => {
        set({ alertRules: get().alertRules.filter((r) => r.id !== id) });
      },

      updateAlertRule: (id, updates) => {
        const state = get();
        // Validate rule exists
        if (!state.alertRules.find((r) => r.id === id)) {
          console.warn(`AlertRule with id ${id} not found`);
          return;
        }
        // Exclude id from updates to prevent accidental ID override
        const { id: _excludedId, ...safeUpdates } = updates as { id?: string } & typeof updates;
        const updated = state.alertRules.map((r) =>
          r.id === id ? { ...r, ...safeUpdates } : r
        );
        set({ alertRules: updated });
      },

      triggeredAlerts: [],

      setTriggeredAlerts: (alerts) => {
        set({ triggeredAlerts: alerts });
      },

      clearTriggeredAlerts: () => {
        set({ triggeredAlerts: [] });
      },

      // Gap Finder - Segment Mappings
      customSegmentMappings: [],

      setCustomSegmentMappings: (mappings) => {
        set({ customSegmentMappings: mappings });
      },

      addSegmentMapping: (mapping) => {
        const state = get();
        const existing = state.customSegmentMappings.find(
          (m) => m.keyword.toLowerCase() === mapping.keyword.toLowerCase()
        );
        if (existing) {
          const updated = state.customSegmentMappings.map((m) =>
            m.keyword.toLowerCase() === mapping.keyword.toLowerCase()
              ? mapping
              : m
          );
          set({ customSegmentMappings: updated });
        } else {
          set({ customSegmentMappings: [...state.customSegmentMappings, mapping] });
        }
      },

      removeSegmentMapping: (keyword) => {
        set({
          customSegmentMappings: get().customSegmentMappings.filter(
            (m) => m.keyword.toLowerCase() !== keyword.toLowerCase()
          ),
        });
      },
    }),
    {
      name: 'otofiyatlist-storage',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        favorites: state.favorites,
        compareList: state.compareList,
        trackedVehicles: state.trackedVehicles,
        language: state.language,
        theme: state.theme,
        hasSeenIntro: state.hasSeenIntro,
        priceAlerts: state.priceAlerts,
        // intelModeEnabled intentionally NOT persisted — always defaults to on
        alertRules: state.alertRules,
        customSegmentMappings: state.customSegmentMappings,
      }),
    }
  )
);

// Selector hooks for better performance
export const useFavorites = () => useAppStore((state) => state.favorites);
export const useCompareList = () => useAppStore((state) => state.compareList);
export const useTrackedVehicles = () => useAppStore((state) => state.trackedVehicles);
export const usePriceChanges = () => useAppStore((state) => state.priceChanges);
export const useLanguage = () => useAppStore((state) => state.language);
export const useTheme = () => useAppStore((state) => state.theme);
export const useIntelMode = () => useAppStore((state) => state.intelModeEnabled);
export const useAlertRules = () => useAppStore((state) => state.alertRules);
export const useTriggeredAlerts = () => useAppStore((state) => state.triggeredAlerts);
export const useSegmentMappings = () => useAppStore((state) => state.customSegmentMappings);
