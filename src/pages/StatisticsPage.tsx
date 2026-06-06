// Statistics Page - Advanced price analysis, segment comparisons, and trends
// Uses historical data (no live API calls)
import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Row, Col, Typography, Card, Spin, Empty, Tabs, Statistic, Table, Tag, Progress } from 'antd';
import {
  CarOutlined,
  RiseOutlined,
  FallOutlined,
  DashboardOutlined,
  BarChartOutlined,
  PieChartOutlined,
  UnorderedListOutlined,
  PercentageOutlined,
  CalendarOutlined,
} from '@ant-design/icons';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
  ComposedChart,
  Line,
  Area,
} from 'recharts';

import { getBrandById } from '../config/brands';
import { PriceListRow, StoredData } from '../types';
import { tokens } from '../theme/tokens';
import { staggerContainer, staggerItem } from '../theme/animations';
import { fetchDedup, DATA_URLS } from '../utils/fetchData';
import { ChartInfoTooltip, chartDescriptions } from '../components/common/ChartInfoTooltip';
import { useIsMobile } from '../hooks/useMediaQuery';

const { Title, Text } = Typography;

// Price segment definitions
const PRICE_SEGMENTS = [
  { key: 'budget', min: 0, max: 1500000, color: tokens.colors.success },
  { key: 'mid', min: 1500000, max: 3000000, color: tokens.colors.accent },
  { key: 'premium', min: 3000000, max: 5000000, color: tokens.colors.warning },
  { key: 'luxury', min: 5000000, max: Infinity, color: tokens.colors.error },
];

// Normalize fuel type names (different brands use different naming conventions)
const normalizeFuelType = (fuel: string): string => {
  if (!fuel) return 'Bilinmiyor';

  const fuelLower = fuel.toLowerCase().trim();

  // Electric
  if (fuelLower === 'elektrik' || fuelLower === 'electric') return 'Elektrik';

  // Plug-in Hybrid (check first, before general hybrid)
  if (fuelLower.includes('plug-in') || fuelLower.includes('plugin')) return 'Plug-in Hybrid';

  // Mild Hybrid
  if (fuelLower.includes('mild hybrid') || fuelLower.includes('mhev')) return 'Mild Hybrid';

  // Hybrid (Benzin-Elektrik, Elektrik-Benzin, Hibrit, Hybrid combinations)
  if (
    fuelLower.includes('hybrid') ||
    fuelLower.includes('hibrit') ||
    (fuelLower.includes('benzin') && fuelLower.includes('elektrik')) ||
    (fuelLower.includes('elektrik') && fuelLower.includes('benzin'))
  ) {
    return 'Hybrid';
  }

  // Diesel Hybrid
  if (fuelLower.includes('dizel') && (fuelLower.includes('elektrik') || fuelLower.includes('hybrid'))) {
    return 'Dizel Hybrid';
  }

  // Benzin + LPG
  if (fuelLower.includes('lpg') || fuelLower.includes('benzin-lpg') || fuelLower.includes('lpg-benzin')) {
    return 'Benzin + LPG';
  }

  // CNG
  if (fuelLower.includes('cng') || fuelLower.includes('dogalgaz')) return 'CNG';

  // Diesel
  if (fuelLower === 'dizel' || fuelLower === 'diesel') return 'Dizel';

  // Benzin (check last to avoid matching hybrids)
  if (fuelLower === 'benzin' || fuelLower === 'petrol' || fuelLower === 'gasoline') return 'Benzin';

  // Return original if no match
  return fuel;
};

// Fuel type colors
const FUEL_COLORS: { [key: string]: string } = {
  Benzin: tokens.colors.fuel.benzin,
  Dizel: tokens.colors.fuel.dizel,
  Elektrik: tokens.colors.fuel.elektrik,
  Hybrid: tokens.colors.fuel.hybrid,
  'Plug-in Hybrid': tokens.colors.fuel.pluginHybrid,
  'Mild Hybrid': '#9333ea', // Purple for mild hybrid
  'Dizel Hybrid': '#6366f1', // Indigo for diesel hybrid
  'Benzin + LPG': '#f59e0b', // Amber for LPG
  CNG: tokens.colors.fuel.cng || '#6b7280',
  Bilinmiyor: '#9ca3af',
};

// Transmission colors
const TRANSMISSION_COLORS: { [key: string]: string } = {
  Otomatik: tokens.colors.accent,
  Manuel: tokens.colors.primary,
  'Yarı Otomatik': tokens.colors.warning,
  CVT: tokens.colors.success,
};

export default function StatisticsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [loading, setLoading] = useState(true);
  const [allData, setAllData] = useState<Map<string, StoredData>>(new Map());
  const [activeTab, setActiveTab] = useState('overview');

  // Fetch all brands via single /latest endpoint
  useEffect(() => {
    let cancelled = false;

    const fetchAllBrands = async () => {
      setLoading(true);
      const dataMap = new Map<string, StoredData>();

      try {
        const latestData = await fetchDedup<any>(DATA_URLS.latest);

        Object.entries(latestData.brands || {}).forEach(([brandId, brand]: [string, any]) => {
          dataMap.set(brandId, {
            collectedAt: latestData.generatedAt,
            brand: brand.name,
            brandId,
            rowCount: brand.vehicles?.length || 0,
            rows: brand.vehicles || [],
          });
        });
      } catch (error) {
        console.error('Failed to fetch latest data:', error);
      }

      if (!cancelled) {
        setAllData(dataMap);
        setLoading(false);
      }
    };

    fetchAllBrands();

    return () => { cancelled = true; };
  }, []);

  // Combine all rows
  const allRows = useMemo(() => {
    const rows: PriceListRow[] = [];
    allData.forEach((data) => {
      rows.push(...data.rows);
    });
    return rows;
  }, [allData]);

  // Summary statistics
  const summaryStats = useMemo(() => {
    if (allRows.length === 0) return null;

    const prices = allRows.map((r) => r.priceNumeric).sort((a, b) => a - b);
    const sum = prices.reduce((a, b) => a + b, 0);
    const avg = sum / prices.length;
    const median = prices.length % 2 === 0
      ? (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2
      : prices[Math.floor(prices.length / 2)];

    return {
      total: allRows.length,
      brands: allData.size,
      avgPrice: Math.round(avg),
      medianPrice: Math.round(median),
      minPrice: prices[0],
      maxPrice: prices[prices.length - 1],
      priceSpread: prices[prices.length - 1] - prices[0],
    };
  }, [allRows, allData]);

  // Brand average prices
  const brandAverages = useMemo(() => {
    const averages: { brand: string; average: number; count: number; min: number; max: number }[] = [];

    allData.forEach((data, brandId) => {
      const brand = getBrandById(brandId);
      if (brand && data.rows.length > 0) {
        const prices = data.rows.map((r) => r.priceNumeric);
        const sum = prices.reduce((acc, p) => acc + p, 0);
        averages.push({
          brand: brand.name,
          average: Math.round(sum / data.rows.length),
          count: data.rows.length,
          min: Math.min(...prices),
          max: Math.max(...prices),
        });
      }
    });

    // Descending by average so the chart shows highest-priced brands at the top.
    return averages.sort((a, b) => b.average - a.average);
  }, [allData]);

  // Brand model counts
  const brandModelCounts = useMemo(() => {
    return brandAverages
      .map((b) => ({ brand: b.brand, count: b.count }))
      .sort((a, b) => b.count - a.count);
  }, [brandAverages]);

  // Fuel distribution (with normalization)
  const fuelDistribution = useMemo(() => {
    const fuelCounts: { [key: string]: number } = {};

    allRows.forEach((row) => {
      if (row.fuel) {
        const normalizedFuel = normalizeFuelType(row.fuel);
        fuelCounts[normalizedFuel] = (fuelCounts[normalizedFuel] || 0) + 1;
      }
    });

    return Object.entries(fuelCounts)
      .map(([name, value]) => ({
        name,
        value,
        color: FUEL_COLORS[name] || tokens.colors.gray[400],
      }))
      .sort((a, b) => b.value - a.value);
  }, [allRows]);

  // Transmission distribution
  const transmissionDistribution = useMemo(() => {
    const counts: { [key: string]: number } = {};

    allRows.forEach((row) => {
      if (row.transmission) {
        counts[row.transmission] = (counts[row.transmission] || 0) + 1;
      }
    });

    return Object.entries(counts)
      .map(([name, value]) => ({
        name,
        value,
        color: TRANSMISSION_COLORS[name] || tokens.colors.gray[400],
      }))
      .sort((a, b) => b.value - a.value);
  }, [allRows]);

  // Price segment distribution
  const segmentDistribution = useMemo(() => {
    const segments = PRICE_SEGMENTS.map((seg) => ({
      name: t(`segments.priceRanges.${seg.key}`),
      value: 0,
      color: seg.color,
    }));

    allRows.forEach((row) => {
      const segIndex = PRICE_SEGMENTS.findIndex(
        (seg) => row.priceNumeric >= seg.min && row.priceNumeric < seg.max
      );
      if (segIndex >= 0) {
        segments[segIndex].value += 1;
      }
    });

    return segments.filter((s) => s.value > 0);
  }, [allRows, t]);

  // Price distribution histogram (binned)
  const priceHistogram = useMemo(() => {
    if (allRows.length === 0) return [];

    const bins = [
      { label: '0-1M', min: 0, max: 1000000, count: 0 },
      { label: '1-1.5M', min: 1000000, max: 1500000, count: 0 },
      { label: '1.5-2M', min: 1500000, max: 2000000, count: 0 },
      { label: '2-2.5M', min: 2000000, max: 2500000, count: 0 },
      { label: '2.5-3M', min: 2500000, max: 3000000, count: 0 },
      { label: '3-4M', min: 3000000, max: 4000000, count: 0 },
      { label: '4-5M', min: 4000000, max: 5000000, count: 0 },
      { label: '5-7M', min: 5000000, max: 7000000, count: 0 },
      { label: '7-10M', min: 7000000, max: 10000000, count: 0 },
      { label: '10M+', min: 10000000, max: Infinity, count: 0 },
    ];

    allRows.forEach((row) => {
      const bin = bins.find((b) => row.priceNumeric >= b.min && row.priceNumeric < b.max);
      if (bin) bin.count += 1;
    });

    return bins.filter((b) => b.count > 0);
  }, [allRows]);

  // Price range by brand (for scatter chart)
  const brandPriceScatter = useMemo(() => {
    return brandAverages.map((b, index) => ({
      brand: b.brand,
      x: index,
      y: b.average,
      z: b.count,
      min: b.min,
      max: b.max,
      spread: b.max - b.min,
    }));
  }, [brandAverages]);

  // Top 10 cheapest and most expensive
  const topCheapest = useMemo(() => {
    return [...allRows]
      .sort((a, b) => a.priceNumeric - b.priceNumeric)
      .slice(0, 10)
      .map((row, index) => ({
        key: index,
        rank: index + 1,
        brand: row.brand,
        model: row.model,
        trim: row.trim,
        price: row.priceNumeric,
        priceRaw: row.priceRaw,
        fuel: row.fuel,
      }));
  }, [allRows]);

  const topExpensive = useMemo(() => {
    return [...allRows]
      .sort((a, b) => b.priceNumeric - a.priceNumeric)
      .slice(0, 10)
      .map((row, index) => ({
        key: index,
        rank: index + 1,
        brand: row.brand,
        model: row.model,
        trim: row.trim,
        price: row.priceNumeric,
        priceRaw: row.priceRaw,
        fuel: row.fuel,
      }));
  }, [allRows]);

  // OTV statistics
  const otvStats = useMemo(() => {
    const otvData: { rate: number; price: number; brand: string }[] = [];

    allRows.forEach((row) => {
      if (row.otvRate && row.otvRate > 0) {
        otvData.push({
          rate: row.otvRate,
          price: row.priceNumeric,
          brand: row.brand,
        });
      }
    });

    if (otvData.length === 0) return null;

    // Group by OTV rate
    const rateGroups = new Map<number, { prices: number[]; count: number }>();
    const brandOtvData = new Map<string, { rates: number[]; count: number }>();

    for (const d of otvData) {
      // Rate distribution
      if (!rateGroups.has(d.rate)) {
        rateGroups.set(d.rate, { prices: [], count: 0 });
      }
      const group = rateGroups.get(d.rate)!;
      group.prices.push(d.price);
      group.count++;

      // Brand OTV
      if (!brandOtvData.has(d.brand)) {
        brandOtvData.set(d.brand, { rates: [], count: 0 });
      }
      const brandGroup = brandOtvData.get(d.brand)!;
      brandGroup.rates.push(d.rate);
      brandGroup.count++;
    }

    const avgOtvRate = otvData.reduce((sum, d) => sum + d.rate, 0) / otvData.length;

    const distribution = Array.from(rateGroups.entries())
      .map(([rate, data]) => ({
        rate: `%${rate}`,
        rateNum: rate,
        count: data.count,
        percentage: Math.round((data.count / otvData.length) * 100 * 10) / 10,
        avgPrice: data.prices.length > 0
          ? Math.round(data.prices.reduce((a, b) => a + b, 0) / data.prices.length)
          : 0,
      }))
      .sort((a, b) => a.rateNum - b.rateNum);

    const byBrand = Array.from(brandOtvData.entries())
      .map(([brand, data]) => ({
        brand,
        avgOtvRate: Math.round((data.rates.reduce((a, b) => a + b, 0) / data.rates.length) * 10) / 10,
        count: data.count,
      }))
      .sort((a, b) => b.count - a.count);

    return {
      totalWithOtv: otvData.length,
      avgOtvRate: Math.round(avgOtvRate * 10) / 10,
      distribution,
      byBrand,
    };
  }, [allRows]);

  // Model year statistics
  const modelYearStats = useMemo(() => {
    const yearData = new Map<string, { prices: number[]; count: number }>();

    // Normalize model year: "MY25" → "2025", "MY26" → "2026"
    const normalizeYear = (year: string | number): string => {
      const str = String(year).toUpperCase();
      if (str === 'MY25') return '2025';
      if (str === 'MY26') return '2026';
      if (str.startsWith('MY') && str.length === 4) {
        const num = parseInt(str.slice(2), 10);
        if (!isNaN(num)) return `20${num}`;
      }
      return String(year);
    };

    allRows.forEach((row) => {
      if (row.modelYear) {
        const year = normalizeYear(row.modelYear);
        if (!yearData.has(year)) {
          yearData.set(year, { prices: [], count: 0 });
        }
        const group = yearData.get(year)!;
        group.prices.push(row.priceNumeric);
        group.count++;
      }
    });

    if (yearData.size === 0) return null;

    const totalWithYear = Array.from(yearData.values()).reduce((sum, d) => sum + d.count, 0);

    const distribution = Array.from(yearData.entries())
      .map(([year, data]) => ({
        year,
        count: data.count,
        percentage: Math.round((data.count / totalWithYear) * 100 * 10) / 10,
        avgPrice: data.prices.length > 0
          ? Math.round(data.prices.reduce((a, b) => a + b, 0) / data.prices.length)
          : 0,
      }))
      .sort((a, b) => b.year.localeCompare(a.year)); // Sort by year descending

    return {
      totalWithYear,
      distribution,
    };
  }, [allRows]);

  // Powertrain distribution (Electric, Plug-in Hybrid, Mild Hybrid, Hybrid, ICE)
  const powertrainDistribution = useMemo(() => {
    const counts = {
      electric: 0,
      pluginHybrid: 0,
      mildHybrid: 0,
      hybrid: 0,
      ice: 0,
    };
    const prices = {
      electric: [] as number[],
      pluginHybrid: [] as number[],
      mildHybrid: [] as number[],
      hybrid: [] as number[],
      ice: [] as number[],
    };

    allRows.forEach((row) => {
      if (row.isElectric) {
        counts.electric++;
        prices.electric.push(row.priceNumeric);
      } else if (row.isPlugInHybrid) {
        counts.pluginHybrid++;
        prices.pluginHybrid.push(row.priceNumeric);
      } else if (row.isMildHybrid) {
        counts.mildHybrid++;
        prices.mildHybrid.push(row.priceNumeric);
      } else if (row.isHybrid) {
        counts.hybrid++;
        prices.hybrid.push(row.priceNumeric);
      } else {
        counts.ice++;
        prices.ice.push(row.priceNumeric);
      }
    });

    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const hasData = counts.electric > 0 || counts.pluginHybrid > 0 || counts.mildHybrid > 0 || counts.hybrid > 0;

    if (!hasData) return null;

    const calcAvg = (arr: number[]) => arr.length > 0 ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;

    return {
      distribution: [
        { name: 'Elektrikli', value: counts.electric, color: tokens.colors.fuel.elektrik, avgPrice: calcAvg(prices.electric) },
        { name: 'Plug-in Hybrid', value: counts.pluginHybrid, color: '#10b981', avgPrice: calcAvg(prices.pluginHybrid) },
        { name: 'Mild Hybrid', value: counts.mildHybrid, color: '#8b5cf6', avgPrice: calcAvg(prices.mildHybrid) },
        { name: 'Hybrid', value: counts.hybrid, color: tokens.colors.fuel.hybrid, avgPrice: calcAvg(prices.hybrid) },
        { name: 'Benzin/Dizel', value: counts.ice, color: tokens.colors.fuel.benzin, avgPrice: calcAvg(prices.ice) },
      ].filter((x) => x.value > 0),
      total,
      electrifiedCount: counts.electric + counts.pluginHybrid + counts.mildHybrid + counts.hybrid,
      electrifiedPercent: Math.round(((counts.electric + counts.pluginHybrid + counts.mildHybrid + counts.hybrid) / total) * 100 * 10) / 10,
    };
  }, [allRows]);

  // Drive type distribution (AWD, FWD, RWD)
  const driveTypeDistribution = useMemo(() => {
    const counts: { [key: string]: { count: number; prices: number[] } } = {};

    allRows.forEach((row) => {
      if (row.driveType) {
        if (!counts[row.driveType]) {
          counts[row.driveType] = { count: 0, prices: [] };
        }
        counts[row.driveType].count++;
        counts[row.driveType].prices.push(row.priceNumeric);
      }
    });

    const total = Object.values(counts).reduce((sum, d) => sum + d.count, 0);
    if (total === 0) return null;

    const labels: { [key: string]: string } = {
      AWD: t('common.driveTypes.awd'),
      FWD: t('common.driveTypes.fwd'),
      RWD: t('common.driveTypes.rwd'),
    };
    const colors: { [key: string]: string } = {
      AWD: '#3b82f6',
      FWD: '#22c55e',
      RWD: '#f97316',
    };

    return {
      distribution: Object.entries(counts).map(([type, data]) => ({
        name: labels[type] || type,
        type,
        value: data.count,
        color: colors[type] || tokens.colors.gray[400],
        avgPrice: data.prices.length > 0 ? Math.round(data.prices.reduce((a, b) => a + b, 0) / data.prices.length) : 0,
        percentage: Math.round((data.count / total) * 100 * 10) / 10,
      })),
      total,
    };
  }, [allRows, t]);

  // EV range comparison
  const evRangeStats = useMemo(() => {
    const evs = allRows.filter((r) => r.isElectric && r.wltpRange && r.wltpRange > 0);
    if (evs.length === 0) return null;

    const sorted = [...evs].sort((a, b) => (b.wltpRange || 0) - (a.wltpRange || 0));
    const avgRange = Math.round(evs.reduce((sum, r) => sum + (r.wltpRange || 0), 0) / evs.length);
    const avgPrice = Math.round(evs.reduce((sum, r) => sum + r.priceNumeric, 0) / evs.length);

    return {
      count: evs.length,
      avgRange,
      avgPrice,
      avgPricePerKm: avgPrice > 0 && avgRange > 0 ? Math.round(avgPrice / avgRange) : 0,
      topRange: sorted.slice(0, 10).map((r) => ({
        brand: r.brand,
        model: r.model,
        trim: r.trim,
        range: r.wltpRange || 0,
        price: r.priceNumeric,
        pricePerKm: Math.round(r.priceNumeric / (r.wltpRange || 1)),
        batteryCapacity: r.batteryCapacity,
      })),
      bestValue: [...evs]
        .map((r) => ({
          brand: r.brand,
          model: r.model,
          trim: r.trim,
          range: r.wltpRange || 0,
          price: r.priceNumeric,
          pricePerKm: Math.round(r.priceNumeric / (r.wltpRange || 1)),
        }))
        .sort((a, b) => a.pricePerKm - b.pricePerKm)
        .slice(0, 10),
    };
  }, [allRows]);

  // Power (HP) statistics
  const powerStats = useMemo(() => {
    const withPower = allRows.filter((r) => r.powerHP && r.powerHP > 0);
    if (withPower.length === 0) return null;

    const avgHP = Math.round(withPower.reduce((sum, r) => sum + (r.powerHP || 0), 0) / withPower.length);
    const avgTLPerHP = Math.round(
      withPower.reduce((sum, r) => sum + r.priceNumeric / (r.powerHP || 1), 0) / withPower.length
    );

    const bestValue = [...withPower]
      .map((r) => ({
        brand: r.brand,
        model: r.model,
        trim: r.trim,
        powerHP: r.powerHP || 0,
        powerKW: r.powerKW,
        price: r.priceNumeric,
        tlPerHP: Math.round(r.priceNumeric / (r.powerHP || 1)),
      }))
      .sort((a, b) => a.tlPerHP - b.tlPerHP)
      .slice(0, 10);

    const mostPowerful = [...withPower]
      .sort((a, b) => (b.powerHP || 0) - (a.powerHP || 0))
      .slice(0, 10)
      .map((r) => ({
        brand: r.brand,
        model: r.model,
        trim: r.trim,
        powerHP: r.powerHP || 0,
        powerKW: r.powerKW,
        price: r.priceNumeric,
        tlPerHP: Math.round(r.priceNumeric / (r.powerHP || 1)),
      }));

    // Power segments (inclusive upper bounds)
    const segments = [
      { label: '≤100 HP', min: 0, max: 101, count: 0 },
      { label: '101-150 HP', min: 101, max: 151, count: 0 },
      { label: '151-200 HP', min: 151, max: 201, count: 0 },
      { label: '201-300 HP', min: 201, max: 301, count: 0 },
      { label: '301-400 HP', min: 301, max: 401, count: 0 },
      { label: '400+ HP', min: 401, max: Infinity, count: 0 },
    ];
    withPower.forEach((r) => {
      const seg = segments.find((s) => (r.powerHP || 0) >= s.min && (r.powerHP || 0) < s.max);
      if (seg) seg.count++;
    });

    return {
      count: withPower.length,
      avgHP,
      avgTLPerHP,
      bestValue,
      mostPowerful,
      segments: segments.filter((s) => s.count > 0),
    };
  }, [allRows]);

  // Brand fuel breakdown (with normalization)
  const brandFuelBreakdown = useMemo(() => {
    const breakdown: { brand: string; [key: string]: number | string }[] = [];

    allData.forEach((data, brandId) => {
      const brand = getBrandById(brandId);
      if (brand) {
        const fuelCounts: { [key: string]: number } = {};
        data.rows.forEach((row) => {
          if (row.fuel) {
            const normalizedFuel = normalizeFuelType(row.fuel);
            fuelCounts[normalizedFuel] = (fuelCounts[normalizedFuel] || 0) + 1;
          }
        });
        breakdown.push({
          brand: brand.name,
          ...fuelCounts,
        });
      }
    });

    return breakdown.sort((a, b) => (a.brand as string).localeCompare(b.brand as string, 'tr'));
  }, [allData]);

  const formatPrice = (value: number) => {
    return new Intl.NumberFormat('tr-TR', {
      style: 'currency',
      currency: 'TRY',
      maximumFractionDigits: 0,
    }).format(value);
  };

  const formatPriceShort = (value: number) => {
    if (value >= 1000000) {
      return `${(value / 1000000).toFixed(1)}M`;
    }
    return `${(value / 1000).toFixed(0)}K`;
  };

  // Table columns for top lists
  const topListColumns = [
    {
      title: '#',
      dataIndex: 'rank',
      key: 'rank',
      width: 50,
    },
    {
      title: t('common.brand'),
      dataIndex: 'brand',
      key: 'brand',
      width: 100,
    },
    {
      title: t('common.model'),
      dataIndex: 'model',
      key: 'model',
      width: 120,
    },
    {
      title: t('common.trim'),
      dataIndex: 'trim',
      key: 'trim',
      ellipsis: true,
    },
    {
      title: t('common.fuel'),
      dataIndex: 'fuel',
      key: 'fuel',
      width: 100,
      render: (fuel: string) => (
        <Tag color={FUEL_COLORS[fuel] || 'default'} style={{ color: '#fff' }}>
          {fuel}
        </Tag>
      ),
    },
    {
      title: t('common.price'),
      dataIndex: 'priceRaw',
      key: 'price',
      width: 150,
      render: (price: string) => <Text strong style={{ color: tokens.colors.success }}>{price}</Text>,
    },
  ];

  if (loading) {
    return (
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '60vh',
        }}
      >
        <Spin size="large" />
      </div>
    );
  }

  if (allRows.length === 0) {
    return (
      <motion.div
        variants={staggerContainer}
        initial="initial"
        animate="enter"
        style={{ padding: tokens.spacing.lg }}
      >
        <Empty description={t('common.noData')} />
      </motion.div>
    );
  }

  const tabItems = [
    {
      key: 'overview',
      label: (
        <span>
          <DashboardOutlined /> {t('statistics.tabs.overview', 'Genel Bakis')}
        </span>
      ),
      children: (
        <Row gutter={[24, 24]}>
          {/* Summary Stats Cards */}
          <Col span={24}>
            <Row gutter={[16, 16]}>
              <Col xs={12} sm={8} md={4}>
                <Card size="small" style={{ borderRadius: tokens.borderRadius.md }}>
                  <Statistic
                    title={t('statistics.summary.totalVehicles', 'Toplam Arac')}
                    value={summaryStats?.total || 0}
                    prefix={<CarOutlined />}
                  />
                </Card>
              </Col>
              <Col xs={12} sm={8} md={4}>
                <Card size="small" style={{ borderRadius: tokens.borderRadius.md }}>
                  <Statistic
                    title={t('statistics.summary.totalBrands', 'Marka Sayisi')}
                    value={summaryStats?.brands || 0}
                  />
                </Card>
              </Col>
              <Col xs={12} sm={8} md={4}>
                <Card size="small" style={{ borderRadius: tokens.borderRadius.md }}>
                  <Statistic
                    title={t('statistics.summary.avgPrice', 'Ortalama')}
                    value={summaryStats?.avgPrice || 0}
                    formatter={(v) => formatPriceShort(v as number)}
                  />
                </Card>
              </Col>
              <Col xs={12} sm={8} md={4}>
                <Card size="small" style={{ borderRadius: tokens.borderRadius.md }}>
                  <Statistic
                    title={t('statistics.summary.medianPrice', 'Medyan')}
                    value={summaryStats?.medianPrice || 0}
                    formatter={(v) => formatPriceShort(v as number)}
                  />
                </Card>
              </Col>
              <Col xs={12} sm={8} md={4}>
                <Card size="small" style={{ borderRadius: tokens.borderRadius.md }}>
                  <Statistic
                    title={t('statistics.priceTrend.minPrice', 'Minimum')}
                    value={summaryStats?.minPrice || 0}
                    formatter={(v) => formatPriceShort(v as number)}
                    valueStyle={{ color: tokens.colors.success }}
                    prefix={<FallOutlined />}
                  />
                </Card>
              </Col>
              <Col xs={12} sm={8} md={4}>
                <Card size="small" style={{ borderRadius: tokens.borderRadius.md }}>
                  <Statistic
                    title={t('statistics.priceTrend.maxPrice', 'Maksimum')}
                    value={summaryStats?.maxPrice || 0}
                    formatter={(v) => formatPriceShort(v as number)}
                    valueStyle={{ color: tokens.colors.error }}
                    prefix={<RiseOutlined />}
                  />
                </Card>
              </Col>
            </Row>
          </Col>

          {/* Price Distribution Histogram */}
          <Col xs={24} lg={16}>
            <Card
              title={t('statistics.priceDistribution', 'Fiyat Dagilimi')}
              style={{ borderRadius: tokens.borderRadius.lg }}
            >
              <ResponsiveContainer width="100%" height={isMobile ? 250 : 350}>
                <BarChart data={priceHistogram}>
                  <CartesianGrid strokeDasharray="3 3" stroke={tokens.colors.gray[200]} />
                  <XAxis dataKey="label" angle={isMobile ? -45 : 0} textAnchor={isMobile ? 'end' : 'middle'} height={isMobile ? 60 : 30} fontSize={isMobile ? 10 : 12} />
                  <YAxis fontSize={isMobile ? 10 : 12} />
                  <Tooltip
                    formatter={(value: number) => [`${value} ${t('common.vehicle')}`, t('common.count')]}
                    labelFormatter={(label) => `${t('common.price')}: ${label} TL`}
                  />
                  <Bar dataKey="count" fill={tokens.colors.accent} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </Card>
          </Col>

          {/* Segment Distribution */}
          <Col xs={24} lg={8}>
            <Card
              title={t('statistics.segmentAnalysis.title')}
              style={{ borderRadius: tokens.borderRadius.lg, height: '100%' }}
            >
              <div style={{ marginBottom: tokens.spacing.md }}>
                {segmentDistribution.map((seg) => {
                  const percent = ((seg.value / (summaryStats?.total || 1)) * 100).toFixed(1);
                  return (
                    <div key={seg.name} style={{ marginBottom: tokens.spacing.sm }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                        <Text>{seg.name}</Text>
                        <Text strong>{seg.value} ({percent}%)</Text>
                      </div>
                      <Progress
                        percent={parseFloat(percent)}
                        showInfo={false}
                        strokeColor={seg.color}
                        size="small"
                      />
                    </div>
                  );
                })}
              </div>
            </Card>
          </Col>

          {/* Fuel & Transmission Distribution */}
          <Col xs={24} md={12}>
            <Card
              title={t('statistics.fuelDistribution', 'Yakit Dagilimi')}
              extra={<ChartInfoTooltip {...chartDescriptions.fuelDistribution} />}
              style={{ borderRadius: tokens.borderRadius.lg }}
            >
              <ResponsiveContainer width="100%" height={isMobile ? 220 : 300}>
                <PieChart>
                  <Pie
                    data={fuelDistribution}
                    cx="50%"
                    cy="50%"
                    innerRadius={isMobile ? 40 : 60}
                    outerRadius={isMobile ? 70 : 100}
                    paddingAngle={2}
                    dataKey="value"
                    label={isMobile ? false : ({ name, percent }) => `${name} (${(percent * 100).toFixed(0)}%)`}
                  >
                    {fuelDistribution.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip />
                  {isMobile && <Legend />}
                </PieChart>
              </ResponsiveContainer>
            </Card>
          </Col>

          <Col xs={24} md={12}>
            <Card
              title={t('statistics.transmissionDistribution', 'Sanziman Dagilimi')}
              extra={<ChartInfoTooltip {...chartDescriptions.transmissionDistribution} />}
              style={{ borderRadius: tokens.borderRadius.lg }}
            >
              <ResponsiveContainer width="100%" height={isMobile ? 220 : 300}>
                <PieChart>
                  <Pie
                    data={transmissionDistribution}
                    cx="50%"
                    cy="50%"
                    innerRadius={isMobile ? 40 : 60}
                    outerRadius={isMobile ? 70 : 100}
                    paddingAngle={2}
                    dataKey="value"
                    label={isMobile ? false : ({ name, percent }) => `${name} (${(percent * 100).toFixed(0)}%)`}
                  >
                    {transmissionDistribution.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip />
                  {isMobile && <Legend />}
                </PieChart>
              </ResponsiveContainer>
            </Card>
          </Col>
        </Row>
      ),
    },
    {
      key: 'brands',
      label: (
        <span>
          <BarChartOutlined /> {t('statistics.tabs.brands', 'Markalar')}
        </span>
      ),
      children: (
        <Row gutter={[24, 24]}>
          {/* Brand Average Prices */}
          <Col xs={24} lg={14}>
            <Card
              title={t('statistics.priceComparison.avgByBrand')}
              extra={<ChartInfoTooltip {...chartDescriptions.brandPriceComparison} />}
              style={{ borderRadius: tokens.borderRadius.lg }}
            >
              <ResponsiveContainer width="100%" height={Math.max(isMobile ? 300 : 400, brandAverages.length * (isMobile ? 25 : 35))}>
                <BarChart data={brandAverages} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke={tokens.colors.gray[200]} />
                  <XAxis
                    type="number"
                    tickFormatter={(value) => formatPriceShort(value)}
                    fontSize={isMobile ? 10 : 12}
                  />
                  <YAxis type="category" dataKey="brand" width={isMobile ? 60 : 90} fontSize={isMobile ? 10 : 12} />
                  <Tooltip
                    formatter={(value: number) => [formatPrice(value), t('common.average')]}
                    labelStyle={{ color: tokens.colors.gray[700] }}
                  />
                  <Bar dataKey="average" fill={tokens.colors.accent} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </Card>
          </Col>

          {/* Brand Model Counts */}
          <Col xs={24} lg={10}>
            <Card
              title={t('statistics.modelCount', 'Model Sayisi')}
              extra={<ChartInfoTooltip {...chartDescriptions.modelCount} />}
              style={{ borderRadius: tokens.borderRadius.lg, marginBottom: tokens.spacing.lg }}
            >
              <ResponsiveContainer width="100%" height={isMobile ? 220 : 300}>
                <BarChart data={brandModelCounts.slice(0, 10)} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke={tokens.colors.gray[200]} />
                  <XAxis type="number" fontSize={isMobile ? 10 : 12} />
                  <YAxis type="category" dataKey="brand" width={isMobile ? 60 : 90} fontSize={isMobile ? 10 : 12} />
                  <Tooltip formatter={(value: number) => [`${value} ${t('common.model').toLowerCase()}`, t('common.count')]} />
                  <Bar dataKey="count" fill={tokens.colors.primary} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </Card>

            {/* Price Range by Brand */}
            <Card
              title={t('statistics.priceComparison.priceRange')}
              style={{ borderRadius: tokens.borderRadius.lg }}
              bodyStyle={{ maxHeight: 300, overflow: 'auto' }}
            >
              {[...brandAverages].sort((a, b) => a.brand.localeCompare(b.brand, 'tr')).map((item) => (
                <div
                  key={item.brand}
                  style={{
                    padding: `${tokens.spacing.sm} 0`,
                    borderBottom: `1px solid ${tokens.colors.gray[100]}`,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Text strong>{item.brand}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>{item.count} {t('common.model').toLowerCase()}</Text>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      marginTop: tokens.spacing.xs,
                    }}
                  >
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      <span style={{ color: tokens.colors.success }}>{formatPriceShort(item.min)}</span>
                    </Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {t('common.avg')}: {formatPriceShort(item.average)}
                    </Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      <span style={{ color: tokens.colors.error }}>{formatPriceShort(item.max)}</span>
                    </Text>
                  </div>
                </div>
              ))}
            </Card>
          </Col>

          {/* Brand Price Positioning Scatter */}
          <Col span={24}>
            <Card
              title={t('statistics.brandPricePositioning', 'Marka Fiyat Konumlandirmasi')}
              extra={<ChartInfoTooltip {...chartDescriptions.brandPriceComparison} />}
              style={{ borderRadius: tokens.borderRadius.lg }}
            >
              <ResponsiveContainer width="100%" height={isMobile ? 300 : 400}>
                <ComposedChart data={brandPriceScatter}>
                  <CartesianGrid strokeDasharray="3 3" stroke={tokens.colors.gray[200]} />
                  <XAxis dataKey="brand" angle={-45} textAnchor="end" height={isMobile ? 60 : 80} interval={0} fontSize={isMobile ? 9 : 11} />
                  <YAxis tickFormatter={(v) => formatPriceShort(v)} fontSize={isMobile ? 10 : 12} />
                  <Tooltip
                    formatter={(value: number, name: string) => {
                      if (name === 'y') return [formatPrice(value), t('common.average')];
                      if (name === 'min') return [formatPrice(value), t('common.minimum')];
                      if (name === 'max') return [formatPrice(value), t('common.maximum')];
                      return [value, name];
                    }}
                  />
                  <Legend />
                  <Area type="monotone" dataKey="max" fill={tokens.colors.error + '20'} stroke="none" name="max" />
                  <Area type="monotone" dataKey="min" fill={tokens.colors.background} stroke="none" name="min" />
                  <Line type="monotone" dataKey="y" stroke={tokens.colors.accent} strokeWidth={2} dot={{ fill: tokens.colors.accent }} name="Ortalama" />
                </ComposedChart>
              </ResponsiveContainer>
            </Card>
          </Col>
        </Row>
      ),
    },
    {
      key: 'rankings',
      label: (
        <span>
          <UnorderedListOutlined /> {t('statistics.tabs.rankings', 'Siralamalur')}
        </span>
      ),
      children: (
        <Row gutter={[24, 24]}>
          {/* Top 10 Cheapest */}
          <Col xs={24} lg={12}>
            <Card
              title={
                <span style={{ color: tokens.colors.success }}>
                  <FallOutlined /> {t('statistics.topCheapest', 'En Uygun 10 Arac')}
                </span>
              }
              style={{ borderRadius: tokens.borderRadius.lg }}
            >
              <Table
                columns={topListColumns}
                dataSource={topCheapest}
                pagination={false}
                size="small"
                scroll={{ x: 600 }}
                onRow={(record) => ({
                  onClick: () => navigate(`/fiyat-listesi?b=${record.brand.toLowerCase()}&q=${record.model}`),
                  style: { cursor: 'pointer' },
                })}
              />
            </Card>
          </Col>

          {/* Top 10 Expensive */}
          <Col xs={24} lg={12}>
            <Card
              title={
                <span style={{ color: tokens.colors.error }}>
                  <RiseOutlined /> {t('statistics.topExpensive', 'En Pahali 10 Arac')}
                </span>
              }
              style={{ borderRadius: tokens.borderRadius.lg }}
            >
              <Table
                columns={topListColumns}
                dataSource={topExpensive}
                pagination={false}
                size="small"
                scroll={{ x: 600 }}
                onRow={(record) => ({
                  onClick: () => navigate(`/fiyat-listesi?b=${record.brand.toLowerCase()}&q=${record.model}`),
                  style: { cursor: 'pointer' },
                })}
              />
            </Card>
          </Col>
        </Row>
      ),
    },
    {
      key: 'fuel',
      label: (
        <span>
          <PieChartOutlined /> {t('statistics.tabs.fuelAnalysis', 'Yakit Analizi')}
        </span>
      ),
      children: (
        <Row gutter={[24, 24]}>
          {/* Brand x Fuel Stacked Bar */}
          <Col span={24}>
            <Card
              title={t('statistics.brandFuelBreakdown', 'Marka Bazli Yakit Dagilimi')}
              style={{ borderRadius: tokens.borderRadius.lg }}
            >
              <ResponsiveContainer width="100%" height={Math.max(isMobile ? 300 : 400, brandFuelBreakdown.length * (isMobile ? 22 : 30))}>
                <BarChart data={brandFuelBreakdown} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke={tokens.colors.gray[200]} />
                  <XAxis type="number" />
                  <YAxis type="category" dataKey="brand" width={90} />
                  <Tooltip />
                  <Legend />
                  {Object.keys(FUEL_COLORS).map((fuel) => (
                    <Bar
                      key={fuel}
                      dataKey={fuel}
                      stackId="fuel"
                      fill={FUEL_COLORS[fuel]}
                      name={fuel}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </Card>
          </Col>

          {/* Fuel Average Prices */}
          <Col xs={24} md={12}>
            <Card
              title={t('statistics.fuelAvgPrices', 'Yakit Tipine Gore Ortalama Fiyat')}
              style={{ borderRadius: tokens.borderRadius.lg }}
            >
              {(() => {
                const fuelPrices: { [key: string]: { sum: number; count: number } } = {};
                allRows.forEach((row) => {
                  if (row.fuel) {
                    const normalizedFuel = normalizeFuelType(row.fuel);
                    if (!fuelPrices[normalizedFuel]) fuelPrices[normalizedFuel] = { sum: 0, count: 0 };
                    fuelPrices[normalizedFuel].sum += row.priceNumeric;
                    fuelPrices[normalizedFuel].count += 1;
                  }
                });
                const fuelAvgData = Object.entries(fuelPrices)
                  .map(([fuel, data]) => ({
                    fuel,
                    avg: Math.round(data.sum / data.count),
                    count: data.count,
                    color: FUEL_COLORS[fuel] || tokens.colors.gray[400],
                  }))
                  .sort((a, b) => a.avg - b.avg);

                return (
                  <ResponsiveContainer width="100%" height={250}>
                    <BarChart data={fuelAvgData} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" stroke={tokens.colors.gray[200]} />
                      <XAxis type="number" tickFormatter={(v) => formatPriceShort(v)} />
                      <YAxis type="category" dataKey="fuel" width={100} />
                      <Tooltip formatter={(value: number) => [formatPrice(value), t('common.average')]} />
                      <Bar dataKey="avg" fill={tokens.colors.accent} radius={[0, 4, 4, 0]}>
                        {fuelAvgData.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry.color} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                );
              })()}
            </Card>
          </Col>

          {/* Transmission Average Prices */}
          <Col xs={24} md={12}>
            <Card
              title={t('statistics.transmissionAvgPrices', 'Sanziman Tipine Gore Ortalama Fiyat')}
              style={{ borderRadius: tokens.borderRadius.lg }}
            >
              {(() => {
                const transPrices: { [key: string]: { sum: number; count: number } } = {};
                allRows.forEach((row) => {
                  if (row.transmission) {
                    if (!transPrices[row.transmission]) transPrices[row.transmission] = { sum: 0, count: 0 };
                    transPrices[row.transmission].sum += row.priceNumeric;
                    transPrices[row.transmission].count += 1;
                  }
                });
                const transAvgData = Object.entries(transPrices)
                  .map(([trans, data]) => ({
                    transmission: trans,
                    avg: Math.round(data.sum / data.count),
                    count: data.count,
                    color: TRANSMISSION_COLORS[trans] || tokens.colors.gray[400],
                  }))
                  .sort((a, b) => a.avg - b.avg);

                return (
                  <ResponsiveContainer width="100%" height={250}>
                    <BarChart data={transAvgData} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" stroke={tokens.colors.gray[200]} />
                      <XAxis type="number" tickFormatter={(v) => formatPriceShort(v)} />
                      <YAxis type="category" dataKey="transmission" width={100} />
                      <Tooltip formatter={(value: number) => [formatPrice(value), t('common.average')]} />
                      <Bar dataKey="avg" fill={tokens.colors.primary} radius={[0, 4, 4, 0]}>
                        {transAvgData.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry.color} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                );
              })()}
            </Card>
          </Col>
        </Row>
      ),
    },
    // Powertrain Analysis Tab
    ...(powertrainDistribution ? [{
      key: 'powertrain',
      label: (
        <span>
          <CarOutlined /> {t('statistics.powertrainTab')}
        </span>
      ),
      children: (
        <Row gutter={[24, 24]}>
          {/* Powertrain Summary */}
          <Col span={24}>
            <Row gutter={[16, 16]}>
              <Col xs={12} sm={8} md={6}>
                <Card size="small" style={{ borderRadius: tokens.borderRadius.md }}>
                  <Statistic
                    title={t('statistics.electrifiedVehicles')}
                    value={powertrainDistribution.electrifiedCount}
                    suffix={`/ ${powertrainDistribution.total}`}
                    valueStyle={{ color: tokens.colors.fuel.elektrik }}
                  />
                </Card>
              </Col>
              <Col xs={12} sm={8} md={6}>
                <Card size="small" style={{ borderRadius: tokens.borderRadius.md }}>
                  <Statistic
                    title={t('statistics.electrificationRate')}
                    value={powertrainDistribution.electrifiedPercent}
                    suffix="%"
                    valueStyle={{ color: tokens.colors.success }}
                  />
                </Card>
              </Col>
            </Row>
          </Col>

          {/* Powertrain Distribution Pie */}
          <Col xs={24} lg={12}>
            <Card
              title={t('statistics.powertrainDistribution')}
              extra={<ChartInfoTooltip {...chartDescriptions.powertrainDistribution} />}
              style={{ borderRadius: tokens.borderRadius.lg }}
            >
              <ResponsiveContainer width="100%" height={isMobile ? 250 : 350}>
                <PieChart>
                  <Pie
                    data={powertrainDistribution.distribution}
                    cx="50%"
                    cy="50%"
                    innerRadius={isMobile ? 40 : 60}
                    outerRadius={isMobile ? 70 : 100}
                    paddingAngle={2}
                    dataKey="value"
                    label={isMobile ? false : ({ name, percent }) => `${name} (${(percent * 100).toFixed(0)}%)`}
                  >
                    {powertrainDistribution.distribution.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </Card>
          </Col>

          {/* Average Price by Powertrain */}
          <Col xs={24} lg={12}>
            <Card
              title={t('statistics.avgPriceByPowertrain')}
              extra={<ChartInfoTooltip {...chartDescriptions.avgPriceByPowertrain} />}
              style={{ borderRadius: tokens.borderRadius.lg }}
            >
              <ResponsiveContainer width="100%" height={isMobile ? 250 : 350}>
                <BarChart data={powertrainDistribution.distribution} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke={tokens.colors.gray[200]} />
                  <XAxis type="number" tickFormatter={(v) => formatPriceShort(v)} fontSize={isMobile ? 10 : 12} />
                  <YAxis type="category" dataKey="name" width={isMobile ? 80 : 120} fontSize={isMobile ? 10 : 12} />
                  <Tooltip formatter={(value: number) => [formatPrice(value), t('statistics.avgPrice')]} />
                  <Bar dataKey="avgPrice" radius={[0, 4, 4, 0]}>
                    {powertrainDistribution.distribution.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </Card>
          </Col>

          {/* Drive Type Distribution */}
          {driveTypeDistribution && (
            <>
              <Col xs={24} lg={12}>
                <Card
                  title={t('statistics.driveTypeDistribution')}
                  extra={<ChartInfoTooltip {...chartDescriptions.driveTypeDistribution} />}
                  style={{ borderRadius: tokens.borderRadius.lg }}
                >
                  <ResponsiveContainer width="100%" height={isMobile ? 220 : 300}>
                    <PieChart>
                      <Pie
                        data={driveTypeDistribution.distribution}
                        cx="50%"
                        cy="50%"
                        innerRadius={isMobile ? 35 : 50}
                        outerRadius={isMobile ? 60 : 80}
                        paddingAngle={2}
                        dataKey="value"
                        label={isMobile ? false : ({ name, percent }) => `${name} (${(percent * 100).toFixed(0)}%)`}
                      >
                        {driveTypeDistribution.distribution.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip />
                      {isMobile && <Legend />}
                    </PieChart>
                  </ResponsiveContainer>
                </Card>
              </Col>

              <Col xs={24} lg={12}>
                <Card
                  title={t('statistics.avgPriceByDriveType')}
                  extra={<ChartInfoTooltip {...chartDescriptions.avgPriceByDriveType} />}
                  style={{ borderRadius: tokens.borderRadius.lg }}
                >
                  <ResponsiveContainer width="100%" height={isMobile ? 220 : 300}>
                    <BarChart data={driveTypeDistribution.distribution}>
                      <CartesianGrid strokeDasharray="3 3" stroke={tokens.colors.gray[200]} />
                      <XAxis dataKey="name" fontSize={isMobile ? 10 : 12} />
                      <YAxis tickFormatter={(v) => formatPriceShort(v)} fontSize={isMobile ? 10 : 12} />
                      <Tooltip formatter={(value: number) => [formatPrice(value), t('statistics.avgPrice')]} />
                      <Bar dataKey="avgPrice" radius={[4, 4, 0, 0]}>
                        {driveTypeDistribution.distribution.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry.color} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </Card>
              </Col>
            </>
          )}

          {/* Power Stats */}
          {powerStats && (
            <>
              <Col span={24}>
                <Row gutter={[16, 16]}>
                  <Col xs={12} sm={8} md={4}>
                    <Card size="small" style={{ borderRadius: tokens.borderRadius.md }}>
                      <Statistic
                        title={t('statistics.withPowerData')}
                        value={powerStats.count}
                        suffix={t('common.vehicle')}
                      />
                    </Card>
                  </Col>
                  <Col xs={12} sm={8} md={4}>
                    <Card size="small" style={{ borderRadius: tokens.borderRadius.md }}>
                      <Statistic
                        title={t('statistics.avgPower')}
                        value={powerStats.avgHP}
                        suffix="HP"
                        valueStyle={{ color: tokens.colors.accent }}
                      />
                    </Card>
                  </Col>
                  <Col xs={12} sm={8} md={4}>
                    <Card size="small" style={{ borderRadius: tokens.borderRadius.md }}>
                      <Statistic
                        title={t('statistics.avgTlPerHp')}
                        value={powerStats.avgTLPerHP}
                        formatter={(v) => formatPriceShort(v as number)}
                        valueStyle={{ color: tokens.colors.warning }}
                      />
                    </Card>
                  </Col>
                </Row>
              </Col>

              {/* Power Segments */}
              <Col xs={24} lg={12}>
                <Card
                  title={t('statistics.powerSegments')}
                  extra={<ChartInfoTooltip {...chartDescriptions.powerSegments} />}
                  style={{ borderRadius: tokens.borderRadius.lg }}
                >
                  <ResponsiveContainer width="100%" height={isMobile ? 220 : 300}>
                    <BarChart data={powerStats.segments}>
                      <CartesianGrid strokeDasharray="3 3" stroke={tokens.colors.gray[200]} />
                      <XAxis dataKey="label" angle={isMobile ? -45 : 0} textAnchor={isMobile ? 'end' : 'middle'} height={isMobile ? 60 : 30} fontSize={isMobile ? 9 : 12} />
                      <YAxis fontSize={isMobile ? 10 : 12} />
                      <Tooltip formatter={(value: number) => [`${value} ${t('common.vehicle')}`, t('common.count')]} />
                      <Bar dataKey="count" fill={tokens.colors.accent} radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </Card>
              </Col>

              {/* Best HP/TL Value */}
              <Col xs={24} lg={12}>
                <Card
                  title={t('statistics.bestPowerValue')}
                  extra={<ChartInfoTooltip {...chartDescriptions.bestHpValue} />}
                  style={{ borderRadius: tokens.borderRadius.lg }}
                >
                  <Table
                    dataSource={powerStats.bestValue.map((r, i) => ({ ...r, key: i, rank: i + 1 }))}
                    columns={[
                      { title: '#', dataIndex: 'rank', key: 'rank', width: 40 },
                      { title: t('common.brand'), dataIndex: 'brand', key: 'brand', width: 80 },
                      { title: t('common.model'), dataIndex: 'model', key: 'model', width: 100 },
                      { title: 'HP', dataIndex: 'powerHP', key: 'powerHP', width: 60, render: (v: number) => <Tag color="blue">{v} HP</Tag> },
                      { title: 'TL/HP', dataIndex: 'tlPerHP', key: 'tlPerHP', render: (v: number) => <Text strong style={{ color: tokens.colors.success }}>{v.toLocaleString('tr-TR')}</Text> },
                    ]}
                    pagination={false}
                    size="small"
                    scroll={{ y: 220 }}
                  />
                </Card>
              </Col>
            </>
          )}
        </Row>
      ),
    }] : []),
    // EV Analysis Tab
    ...(evRangeStats ? [{
      key: 'ev',
      label: (
        <span>
          <DashboardOutlined /> {t('statistics.evAnalysisTab')}
        </span>
      ),
      children: (
        <Row gutter={[24, 24]}>
          {/* EV Summary */}
          <Col span={24}>
            <Row gutter={[16, 16]}>
              <Col xs={12} sm={8} md={4}>
                <Card size="small" style={{ borderRadius: tokens.borderRadius.md }}>
                  <Statistic
                    title={t('statistics.electricVehicles')}
                    value={evRangeStats.count}
                    valueStyle={{ color: tokens.colors.fuel.elektrik }}
                    prefix={<CarOutlined />}
                  />
                </Card>
              </Col>
              <Col xs={12} sm={8} md={4}>
                <Card size="small" style={{ borderRadius: tokens.borderRadius.md }}>
                  <Statistic
                    title={t('statistics.avgRange')}
                    value={evRangeStats.avgRange}
                    suffix="km"
                    valueStyle={{ color: tokens.colors.success }}
                  />
                </Card>
              </Col>
              <Col xs={12} sm={8} md={4}>
                <Card size="small" style={{ borderRadius: tokens.borderRadius.md }}>
                  <Statistic
                    title={t('statistics.avgPrice')}
                    value={evRangeStats.avgPrice}
                    formatter={(v) => formatPriceShort(v as number)}
                    valueStyle={{ color: tokens.colors.accent }}
                  />
                </Card>
              </Col>
              <Col xs={12} sm={8} md={4}>
                <Card size="small" style={{ borderRadius: tokens.borderRadius.md }}>
                  <Statistic
                    title={t('statistics.avgTlPerKm')}
                    value={evRangeStats.avgPricePerKm}
                    formatter={(v) => (v as number).toLocaleString('tr-TR')}
                    valueStyle={{ color: tokens.colors.warning }}
                  />
                </Card>
              </Col>
            </Row>
          </Col>

          {/* Top Range EVs */}
          <Col xs={24} lg={12}>
            <Card
              title={t('statistics.topRangeEvs')}
              extra={<ChartInfoTooltip {...chartDescriptions.evTopRange} />}
              style={{ borderRadius: tokens.borderRadius.lg }}
            >
              <Table
                dataSource={evRangeStats.topRange.map((r, i) => ({ ...r, key: i, rank: i + 1 }))}
                columns={[
                  { title: '#', dataIndex: 'rank', key: 'rank', width: 40 },
                  { title: t('common.brand'), dataIndex: 'brand', key: 'brand', width: 80 },
                  { title: t('common.model'), dataIndex: 'model', key: 'model', width: 100 },
                  {
                    title: t('statistics.avgRange'),
                    dataIndex: 'range',
                    key: 'range',
                    width: 80,
                    render: (v: number) => <Tag color="green">{v} km</Tag>,
                  },
                  {
                    title: t('common.price'),
                    dataIndex: 'price',
                    key: 'price',
                    render: (v: number) => (
                      <Text style={{ color: tokens.colors.success }}>{formatPriceShort(v)}</Text>
                    ),
                  },
                ]}
                pagination={false}
                size="small"
                scroll={{ y: 280 }}
              />
            </Card>
          </Col>

          {/* Best Value EVs (TL/km) */}
          <Col xs={24} lg={12}>
            <Card
              title={t('statistics.bestEvValue')}
              extra={<ChartInfoTooltip {...chartDescriptions.evBestValue} />}
              style={{ borderRadius: tokens.borderRadius.lg }}
            >
              <Table
                dataSource={evRangeStats.bestValue.map((r, i) => ({ ...r, key: i, rank: i + 1 }))}
                columns={[
                  { title: '#', dataIndex: 'rank', key: 'rank', width: 40 },
                  { title: t('common.brand'), dataIndex: 'brand', key: 'brand', width: 80 },
                  { title: t('common.model'), dataIndex: 'model', key: 'model', width: 100 },
                  {
                    title: t('statistics.range'),
                    dataIndex: 'range',
                    key: 'range',
                    width: 80,
                    render: (v: number) => <Tag color="green">{v} km</Tag>,
                  },
                  {
                    title: t('statistics.tlPerKm'),
                    dataIndex: 'pricePerKm',
                    key: 'pricePerKm',
                    render: (v: number) => (
                      <Text strong style={{ color: tokens.colors.success }}>{v.toLocaleString('tr-TR')}</Text>
                    ),
                  },
                ]}
                pagination={false}
                size="small"
                scroll={{ y: 280 }}
              />
            </Card>
          </Col>

          {/* EV Range vs Price Scatter would go here - keeping simple for now */}
        </Row>
      ),
    }] : []),
    // OTV Analysis Tab
    ...(otvStats ? [{
      key: 'otv',
      label: (
        <span>
          <PercentageOutlined /> {t('statistics.otvAnalysisTab')}
        </span>
      ),
      children: (
        <Row gutter={[24, 24]}>
          {/* OTV Summary */}
          <Col span={24}>
            <Row gutter={[16, 16]}>
              <Col xs={12} sm={8} md={6}>
                <Card size="small" style={{ borderRadius: tokens.borderRadius.md }}>
                  <Statistic
                    title={t('statistics.withOtvData')}
                    value={otvStats.totalWithOtv}
                    suffix={`/ ${summaryStats?.total || 0}`}
                  />
                </Card>
              </Col>
              <Col xs={12} sm={8} md={6}>
                <Card size="small" style={{ borderRadius: tokens.borderRadius.md }}>
                  <Statistic
                    title={t('statistics.avgOtvRate')}
                    value={otvStats.avgOtvRate}
                    suffix="%"
                    valueStyle={{ color: tokens.colors.warning }}
                  />
                </Card>
              </Col>
            </Row>
          </Col>

          {/* OTV Distribution Chart */}
          <Col xs={24} lg={12}>
            <Card
              title={t('statistics.otvDistribution')}
              extra={<ChartInfoTooltip {...chartDescriptions.otvDistribution} />}
              style={{ borderRadius: tokens.borderRadius.lg }}
            >
              <ResponsiveContainer width="100%" height={isMobile ? 250 : 350}>
                <BarChart data={otvStats.distribution}>
                  <CartesianGrid strokeDasharray="3 3" stroke={tokens.colors.gray[200]} />
                  <XAxis dataKey="rate" fontSize={isMobile ? 10 : 12} />
                  <YAxis fontSize={isMobile ? 10 : 12} />
                  <Tooltip
                    formatter={(value: number, name: string) => {
                      if (name === 'count') return [`${value} ${t('common.vehicle')}`, t('common.count')];
                      if (name === 'avgPrice') return [formatPrice(value), t('statistics.avgPrice')];
                      return [value, name];
                    }}
                  />
                  <Bar dataKey="count" fill={tokens.colors.warning} radius={[4, 4, 0, 0]} name="count" />
                </BarChart>
              </ResponsiveContainer>
            </Card>
          </Col>

          {/* OTV Average Price by Rate */}
          <Col xs={24} lg={12}>
            <Card
              title={t('statistics.avgPriceByOtv')}
              extra={<ChartInfoTooltip {...chartDescriptions.avgPriceByOtv} />}
              style={{ borderRadius: tokens.borderRadius.lg }}
            >
              <ResponsiveContainer width="100%" height={isMobile ? 250 : 350}>
                <ComposedChart data={otvStats.distribution}>
                  <CartesianGrid strokeDasharray="3 3" stroke={tokens.colors.gray[200]} />
                  <XAxis dataKey="rate" fontSize={isMobile ? 10 : 12} />
                  <YAxis tickFormatter={(v) => formatPriceShort(v)} fontSize={isMobile ? 10 : 12} />
                  <Tooltip
                    formatter={(value: number) => [formatPrice(value), t('statistics.avgPrice')]}
                  />
                  <Bar dataKey="avgPrice" fill={tokens.colors.accent} radius={[4, 4, 0, 0]} />
                  <Line type="monotone" dataKey="avgPrice" stroke={tokens.colors.primary} strokeWidth={2} dot />
                </ComposedChart>
              </ResponsiveContainer>
            </Card>
          </Col>

          {/* Brand OTV Comparison */}
          <Col span={24}>
            <Card
              title={t('statistics.brandOtvComparison')}
              extra={<ChartInfoTooltip {...chartDescriptions.brandOtvComparison} />}
              style={{ borderRadius: tokens.borderRadius.lg }}
            >
              <ResponsiveContainer width="100%" height={Math.max(isMobile ? 220 : 300, otvStats.byBrand.length * (isMobile ? 22 : 30))}>
                <BarChart data={otvStats.byBrand} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke={tokens.colors.gray[200]} />
                  <XAxis type="number" domain={[0, 100]} tickFormatter={(v) => `%${v}`} fontSize={isMobile ? 10 : 12} />
                  <YAxis type="category" dataKey="brand" width={isMobile ? 60 : 100} fontSize={isMobile ? 10 : 12} />
                  <Tooltip
                    formatter={(value: number, name: string) => {
                      if (name === 'avgOtvRate') return [`%${value}`, t('statistics.avgOtv')];
                      if (name === 'count') return [`${value} ${t('common.vehicle')}`, t('common.count')];
                      return [value, name];
                    }}
                  />
                  <Bar dataKey="avgOtvRate" fill={tokens.colors.warning} radius={[0, 4, 4, 0]} name="avgOtvRate" />
                </BarChart>
              </ResponsiveContainer>
            </Card>
          </Col>
        </Row>
      ),
    }] : []),
    // Model Year Tab
    ...(modelYearStats ? [{
      key: 'modelYear',
      label: (
        <span>
          <CalendarOutlined /> {t('statistics.modelYearTab')}
        </span>
      ),
      children: (
        <Row gutter={[24, 24]}>
          {/* Model Year Summary */}
          <Col span={24}>
            <Row gutter={[16, 16]}>
              <Col xs={12} sm={8} md={6}>
                <Card size="small" style={{ borderRadius: tokens.borderRadius.md }}>
                  <Statistic
                    title={t('statistics.withModelYearData')}
                    value={modelYearStats.totalWithYear}
                    suffix={`/ ${summaryStats?.total || 0}`}
                  />
                </Card>
              </Col>
              <Col xs={12} sm={8} md={6}>
                <Card size="small" style={{ borderRadius: tokens.borderRadius.md }}>
                  <Statistic
                    title={t('statistics.uniqueModelYears')}
                    value={modelYearStats.distribution.length}
                  />
                </Card>
              </Col>
            </Row>
          </Col>

          {/* Year Distribution Chart */}
          <Col xs={24} lg={12}>
            <Card
              title={t('statistics.modelYearDistribution')}
              extra={<ChartInfoTooltip {...chartDescriptions.modelYearDistribution} />}
              style={{ borderRadius: tokens.borderRadius.lg }}
            >
              <ResponsiveContainer width="100%" height={isMobile ? 250 : 350}>
                <BarChart data={[...modelYearStats.distribution].reverse()}>
                  <CartesianGrid strokeDasharray="3 3" stroke={tokens.colors.gray[200]} />
                  <XAxis dataKey="year" fontSize={isMobile ? 10 : 12} />
                  <YAxis fontSize={isMobile ? 10 : 12} />
                  <Tooltip
                    formatter={(value: number, name: string) => {
                      if (name === 'count') return [`${value} ${t('common.vehicle')}`, t('common.count')];
                      return [value, name];
                    }}
                  />
                  <Bar dataKey="count" fill={tokens.colors.primary} radius={[4, 4, 0, 0]} name="count" />
                </BarChart>
              </ResponsiveContainer>
            </Card>
          </Col>

          {/* Average Price by Year */}
          <Col xs={24} lg={12}>
            <Card
              title={t('statistics.avgPriceByModelYear')}
              extra={<ChartInfoTooltip {...chartDescriptions.avgPriceByModelYear} />}
              style={{ borderRadius: tokens.borderRadius.lg }}
            >
              <ResponsiveContainer width="100%" height={isMobile ? 250 : 350}>
                <ComposedChart data={[...modelYearStats.distribution].reverse()}>
                  <CartesianGrid strokeDasharray="3 3" stroke={tokens.colors.gray[200]} />
                  <XAxis dataKey="year" fontSize={isMobile ? 10 : 12} />
                  <YAxis tickFormatter={(v) => formatPriceShort(v)} fontSize={isMobile ? 10 : 12} />
                  <Tooltip
                    formatter={(value: number) => [formatPrice(value), t('statistics.avgPrice')]}
                  />
                  <Bar dataKey="avgPrice" fill={tokens.colors.success} radius={[4, 4, 0, 0]} />
                  <Line type="monotone" dataKey="avgPrice" stroke={tokens.colors.error} strokeWidth={2} dot />
                </ComposedChart>
              </ResponsiveContainer>
            </Card>
          </Col>

          {/* Year Details Table */}
          <Col span={24}>
            <Card
              title={t('statistics.modelYearDetails')}
              style={{ borderRadius: tokens.borderRadius.lg }}
            >
              <Table
                dataSource={modelYearStats.distribution.map((d, i) => ({ key: i, ...d }))}
                columns={[
                  {
                    title: t('statistics.modelYear'),
                    dataIndex: 'year',
                    key: 'year',
                    render: (year: string) => <Tag color="blue">{year}</Tag>,
                  },
                  {
                    title: t('statistics.vehicleCount'),
                    dataIndex: 'count',
                    key: 'count',
                    sorter: (a, b) => a.count - b.count,
                  },
                  {
                    title: t('statistics.percentage'),
                    dataIndex: 'percentage',
                    key: 'percentage',
                    render: (pct: number) => (
                      <Progress percent={pct} size="small" style={{ width: 100 }} />
                    ),
                    sorter: (a, b) => a.percentage - b.percentage,
                  },
                  {
                    title: t('statistics.avgPriceColumn'),
                    dataIndex: 'avgPrice',
                    key: 'avgPrice',
                    render: (price: number) => (
                      <Text strong style={{ color: tokens.colors.success }}>{formatPrice(price)}</Text>
                    ),
                    sorter: (a, b) => a.avgPrice - b.avgPrice,
                  },
                ]}
                pagination={false}
                size="small"
              />
            </Card>
          </Col>
        </Row>
      ),
    }] : []),
  ];

  return (
    <motion.div
      variants={staggerContainer}
      initial="initial"
      animate="enter"
      style={{ padding: tokens.spacing.lg }}
    >
      {/* Page Header */}
      <motion.div variants={staggerItem} style={{ marginBottom: tokens.spacing.xl }}>
        <Title level={2} style={{ marginBottom: tokens.spacing.xs }}>
          {t('statistics.title')}
        </Title>
        <Text type="secondary">{t('statistics.subtitle')}</Text>
      </motion.div>

      {/* Tabs */}
      <motion.div variants={staggerItem}>
        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={tabItems}
          size="large"
          style={{ background: tokens.colors.surface, padding: tokens.spacing.lg, borderRadius: tokens.borderRadius.lg }}
        />
      </motion.div>
    </motion.div>
  );
}
