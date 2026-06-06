// Layout Component - Main layout wrapper with header and footer
// Includes price change checking on load
import { useState, useEffect, useRef, Suspense } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Spin } from 'antd';

import Header from './Header';
import Footer from './Footer';
import { tokens } from '../../theme/tokens';
import { pageVariants } from '../../theme/animations';
import { useAppStore, PriceChange } from '../../store';
import { BRANDS } from '../../config/brands';
import { IndexData, StoredData } from '../../types';
import PriceChangeAlert from '../tracking/PriceChangeAlert';
import TrackedVehiclesDrawer from '../tracking/TrackedVehiclesDrawer';
import { OfflineBanner, InstallPrompt } from '../../pwa';
import { CommandPalette } from '../search';
import { ErrorBoundary } from '../errors';
import { useCommandPalette } from '../../hooks/useCommandPalette';
import { fetchFreshJson, fetchDedup, DATA_URLS } from '../../utils/fetchData';
import QuickCompareFAB from '../common/QuickCompareFAB';

interface LatestVehicle {
  brand: string;
  model: string;
  trim: string;
  engine: string;
  fuel: string;
  transmission: string;
  price: number;
  priceFormatted: string;
}

export default function Layout() {
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [vehicles, setVehicles] = useState<LatestVehicle[]>([]);
  const vehiclesFetched = useRef(false);
  const commandPalette = useCommandPalette();

  const {
    trackedVehicles,
    setPriceChanges,
    priceChangesChecked,
    setPriceChangesChecked,
  } = useAppStore();

  // Fetch vehicles for command palette search - only when palette is first opened
  useEffect(() => {
    if (!commandPalette.isOpen || vehiclesFetched.current) return;
    vehiclesFetched.current = true;

    const controller = new AbortController();

    const fetchVehicles = async () => {
      try {
        const data = await fetchDedup<any>(DATA_URLS.latest);
        if (controller.signal.aborted) return;

        // Extract vehicles from brands object
        const allVehicles: LatestVehicle[] = [];
        const brands = data?.brands || {};
        Object.values(brands).forEach((brand: any) => {
          (brand.vehicles || []).forEach((v: any) => {
            allVehicles.push({
              brand: v.brand || brand.name || '',
              model: v.model || '',
              trim: v.trim || '',
              engine: v.engine || '',
              fuel: v.fuel || '',
              transmission: v.transmission || '',
              price: v.priceNumeric || v.price || 0,
              priceFormatted: v.priceRaw || v.priceFormatted || '',
            });
          });
        });

        if (allVehicles.length > 0) {
          setVehicles(allVehicles);
        }
      } catch {
        // Silently fail
      }
    };

    fetchVehicles();
    return () => controller.abort();
  }, [commandPalette.isOpen]);

  // Check for price changes on app load
  useEffect(() => {
    if (trackedVehicles.length === 0 || priceChangesChecked) return;

    const checkPriceChanges = async () => {
      try {
        // Fetch index with fresh data
        const indexData = await fetchFreshJson<IndexData>(DATA_URLS.index);
        const changes: PriceChange[] = [];

        // Group tracked vehicles by brand
        const vehiclesByBrand = new Map<string, typeof trackedVehicles>();
        trackedVehicles.forEach((vehicle) => {
          const brandId = vehicle.brand.toLowerCase();
          const brand = BRANDS.find(
            (b) => b.name.toLowerCase() === brandId || b.id.toLowerCase() === brandId
          );
          if (brand) {
            const existing = vehiclesByBrand.get(brand.id) || [];
            existing.push(vehicle);
            vehiclesByBrand.set(brand.id, existing);
          }
        });

        // Fetch data for each brand and check prices
        await Promise.all(
          Array.from(vehiclesByBrand.entries()).map(async ([brandId, vehicles]) => {
            if (!indexData.brands[brandId]) return;

            try {
              const latestDate = indexData.brands[brandId].latestDate;
              const [year, month, day] = latestDate.split('-');
              const url = DATA_URLS.brandData(year, month, brandId, day);
              const storedData = await fetchDedup<StoredData>(url);

              // Check each tracked vehicle
              vehicles.forEach((trackedVehicle) => {
                const currentRow = storedData.rows.find((row) => {
                  const rowId = `${row.brand}-${row.model}-${row.trim}-${row.engine}`
                    .toLowerCase()
                    .replace(/\s+/g, '-');
                  return rowId === trackedVehicle.id;
                });

                if (currentRow && currentRow.priceNumeric !== trackedVehicle.lastPrice) {
                  const diff = currentRow.priceNumeric - trackedVehicle.lastPrice;
                  const diffPercent =
                    trackedVehicle.lastPrice > 0
                      ? (diff / trackedVehicle.lastPrice) * 100
                      : 0;

                  changes.push({
                    vehicle: trackedVehicle,
                    oldPrice: trackedVehicle.lastPrice,
                    newPrice: currentRow.priceNumeric,
                    oldPriceRaw: trackedVehicle.lastPriceRaw,
                    newPriceRaw: currentRow.priceRaw,
                    diff,
                    diffPercent,
                  });
                }
              });
            } catch (error) {
              console.error(`Failed to check prices for ${brandId}:`, error);
            }
          })
        );

        if (changes.length > 0) {
          setPriceChanges(changes);
        }
        setPriceChangesChecked(true);
      } catch (error) {
        console.error('Failed to check price changes:', error);
        setPriceChangesChecked(true);
      }
    };

    checkPriceChanges();
  }, [trackedVehicles, priceChangesChecked, setPriceChanges, setPriceChangesChecked]);

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        background: tokens.colors.background,
      }}
    >
      <OfflineBanner />
      <Header onOpenTracking={() => setDrawerOpen(true)} />

      <main style={{ flex: 1 }}>
        <div
          style={{
            maxWidth: 1400,
            margin: '0 auto',
            width: '100%',
            padding: `0 ${tokens.spacing.md}`,
          }}
        >
          <PriceChangeAlert onViewChanges={() => setDrawerOpen(true)} />
        </div>

        <AnimatePresence mode="popLayout">
          <motion.div
            key={location.pathname}
            variants={pageVariants}
            initial="initial"
            animate="enter"
            exit="exit"
            style={{
              maxWidth: 1400,
              margin: '0 auto',
              width: '100%',
            }}
          >
            <Suspense
              fallback={
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'center',
                    minHeight: '50vh',
                  }}
                >
                  <Spin size="large" />
                </div>
              }
            >
              {/* Isolate page crashes: a render error shows the fallback in the
                  content area (nav/footer stay usable) and resets on navigation. */}
              <ErrorBoundary key={location.pathname}>
                <Outlet />
              </ErrorBoundary>
            </Suspense>
          </motion.div>
        </AnimatePresence>
      </main>

      <Footer />

      <TrackedVehiclesDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
      <InstallPrompt />
      <QuickCompareFAB />
      <CommandPalette
        isOpen={commandPalette.isOpen}
        onClose={commandPalette.close}
        vehicles={vehicles}
      />
    </div>
  );
}
