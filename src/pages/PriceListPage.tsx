// Price List Page - Vehicle price listing from historical data
// Features: URL state sync, tracking, trend modal, virtualization
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Table,
  Input,
  Select,
  Button,
  Alert,
  Spin,
  Space,
  Typography,
  DatePicker,
  Tooltip,
  message,
  Tag,
  Descriptions,
  Slider,
  Row,
  Col,
} from 'antd';
import {
  DownloadOutlined,
  CopyOutlined,
  SearchOutlined,
  ReloadOutlined,
  HeartOutlined,
  HeartFilled,
  SwapOutlined,
  CheckOutlined,
  CalendarOutlined,
  EyeOutlined,
  EyeInvisibleOutlined,
  LineChartOutlined,
  LinkOutlined,
} from '@ant-design/icons';
import type { ColumnsType, TablePaginationConfig } from 'antd/es/table';
import type { SorterResult } from 'antd/es/table/interface';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';

import { PriceListRow, IndexData, StoredData } from '../types';
import { BRANDS } from '../config/brands';
import { exportToCSV, exportToXLSX, copyAsMarkdown } from '../utils/export';
import {
  useAppStore,
  createVehicleIdentifier,
  createVehicleId,
  TrackedVehicle,
} from '../store';
import { staggerContainer, staggerItem, tableRowVariants } from '../theme/animations';
import { tokens } from '../theme/tokens';
import {
  parseQueryToState,
  stateToQuery,
  getShareableUrl,
  copyUrlToClipboard,
  PriceListUrlState,
} from '../utils/urlState';
import PriceTrendModal from '../components/pricelist/PriceTrendModal';
import PriceTrendBadge from '../components/pricelist/PriceTrendBadge';
import BrandDisclaimer from '../components/common/BrandDisclaimer';
import { fetchFreshJson, DATA_URLS } from '../utils/fetchData';
import { useIsMobile } from '../hooks/useMediaQuery';

const { Title, Text } = Typography;
const { Search } = Input;

// Pre-computed style objects to avoid re-creating on every render/row
const iconStyles = {
  heart: { color: tokens.colors.error } as const,
  check: { color: tokens.colors.success } as const,
  accent: { color: tokens.colors.accent } as const,
};

const transmissionBadgeStyle = {
  background: tokens.colors.gray[100],
  padding: '2px 8px',
  borderRadius: tokens.borderRadius.sm,
  fontSize: '12px',
  color: tokens.colors.gray[700],
} as const;

const discountTagStyle = { fontSize: 10, marginTop: 2 } as const;

const cardStyle = {
  background: tokens.colors.surface,
  padding: tokens.spacing.lg,
  borderRadius: tokens.borderRadius.lg,
  marginBottom: tokens.spacing.lg,
} as const;

const labelStyle = { marginRight: 8, color: tokens.colors.gray[600] } as const;
const sectionTitleStyle = { display: 'block' as const, marginBottom: tokens.spacing.sm } as const;
const fullWidthStyle = { width: '100%' as const } as const;
const loadingCenterStyle = { display: 'flex', justifyContent: 'center', padding: tokens.spacing['2xl'] } as const;
const sliderPadStyle = { padding: '0 8px' } as const;
const sliderLabelStyle = { fontSize: 12, marginBottom: 4, display: 'block' as const } as const;

/** Remove exact duplicate rows and assign stable unique _rowKey for virtual scroll */
function prepareRows(rows: PriceListRow[]): PriceListRow[] {
  const seen = new Set<string>();
  const keyCount = new Map<string, number>();
  return rows.filter((row) => {
    const dedupKey = `${row.brand}|${row.model}|${row.trim}|${row.engine}|${row.transmission}|${row.fuel}|${row.priceNumeric}`;
    if (seen.has(dedupKey)) return false;
    seen.add(dedupKey);
    // Assign unique _rowKey: base key + counter suffix for same base key
    const baseKey = `${row.brand}-${row.model}-${row.trim}-${row.engine || 'std'}-${row.transmission || 'auto'}`;
    const count = keyCount.get(baseKey) || 0;
    keyCount.set(baseKey, count + 1);
    (row as any)._rowKey = count > 0 ? `${baseKey}-${count}` : baseKey;
    return true;
  });
}

interface FetchState {
  loading: boolean;
  error: string | null;
  data: {
    rows: PriceListRow[];
    lastUpdated?: string;
    brand: string;
  } | null;
}

export default function PriceListPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();

  const addFavorite = useAppStore((s) => s.addFavorite);
  const removeFavorite = useAppStore((s) => s.removeFavorite);
  const favorites = useAppStore((s) => s.favorites);
  const addToCompare = useAppStore((s) => s.addToCompare);
  const removeFromCompare = useAppStore((s) => s.removeFromCompare);
  const compareList = useAppStore((s) => s.compareList);
  const addTrackedVehicle = useAppStore((s) => s.addTrackedVehicle);
  const removeTrackedVehicle = useAppStore((s) => s.removeTrackedVehicle);
  const trackedVehiclesList = useAppStore((s) => s.trackedVehicles);

  const isFavorite = useCallback((id: string) => favorites.some((f) => f.id === id), [favorites]);
  const isInCompare = useCallback((id: string) => compareList.some((c) => c.id === id), [compareList]);
  const canAddToCompare = useCallback(() => compareList.length < 4, [compareList]);
  const isTracked = useCallback((id: string) => trackedVehiclesList.some((t) => t.id === id), [trackedVehiclesList]);

  // Responsive hooks
  const isMobile = useIsMobile();

  // URL state initialization flag
  const urlInitialized = useRef(false);

  // Parse initial state from URL
  const initialUrlState = useMemo(() => {
    const search = location.search || '';
    return parseQueryToState(search);
  }, []);

  const [selectedBrand, setSelectedBrand] = useState<string>(
    initialUrlState.brand || 'all'
  );
  const [fetchState, setFetchState] = useState<FetchState>({
    loading: true,
    error: null,
    data: null,
  });

  // Date selection
  const [selectedDate, setSelectedDate] = useState<Dayjs | null>(
    initialUrlState.date ? dayjs(initialUrlState.date) : null
  );
  const [indexData, setIndexData] = useState<IndexData | null>(null);
  const [availableDates, setAvailableDates] = useState<string[]>([]);

  // Filters
  const [searchText, setSearchText] = useState(initialUrlState.q || '');
  const [modelFilter, setModelFilter] = useState<string | null>(initialUrlState.model || null);
  const [transmissionFilter, setTransmissionFilter] = useState<string | null>(
    initialUrlState.transmission || null
  );
  const [fuelFilter, setFuelFilter] = useState<string | null>(initialUrlState.fuel || null);
  const [powertrainFilter, setPowertrainFilter] = useState<string | null>(initialUrlState.powertrain || null);
  const [driveTypeFilter, setDriveTypeFilter] = useState<string | null>(initialUrlState.driveType || null);

  // Range filters
  const [priceRange, setPriceRange] = useState<[number, number] | null>(null);
  const [powerRange, setPowerRange] = useState<[number, number] | null>(null);

  // Sorting
  const [sortInfo, setSortInfo] = useState<{
    column: string;
    order: 'ascend' | 'descend';
  } | null>(
    initialUrlState.sort
      ? {
          column: initialUrlState.sort.split(':')[0],
          order: initialUrlState.sort.split(':')[1] === 'desc' ? 'descend' : 'ascend',
        }
      : { column: 'price', order: 'ascend' }
  );

  // Table state
  const [pagination, setPagination] = useState<TablePaginationConfig>({
    current: initialUrlState.page || 1,
    pageSize: initialUrlState.pageSize || 100,
    showSizeChanger: true,
    pageSizeOptions: ['50', '100', '200', '500'],
    showTotal: (total) => `${t('common.total')} ${total} ${t('common.records')}`,
  });

  // Trend modal
  const [trendModalOpen, setTrendModalOpen] = useState(false);
  const [trendVehicle, setTrendVehicle] = useState<PriceListRow | null>(null);

  // Refetch trigger for manual refresh
  const [refetchTrigger, setRefetchTrigger] = useState(0);
  const handleRefresh = useCallback(() => setRefetchTrigger((prev) => prev + 1), []);

  // Update URL when state changes (debounced)
  const updateUrl = useCallback(() => {
    if (!urlInitialized.current) return;

    const state: PriceListUrlState = {
      brand: selectedBrand !== 'all' ? selectedBrand : undefined,
      q: searchText || undefined,
      model: modelFilter || undefined,
      transmission: transmissionFilter || undefined,
      fuel: fuelFilter || undefined,
      powertrain: powertrainFilter || undefined,
      driveType: driveTypeFilter || undefined,
      date: selectedDate?.format('YYYY-MM-DD'),
      sort: sortInfo ? `${sortInfo.column}:${sortInfo.order === 'descend' ? 'desc' : 'asc'}` : undefined,
      page: pagination.current,
      pageSize: pagination.pageSize,
    };

    const query = stateToQuery(state);
    const newPath = `/fiyat-listesi${query}`;

    if (location.pathname + location.search !== newPath) {
      navigate(newPath, { replace: true });
    }
  }, [
    selectedBrand,
    searchText,
    modelFilter,
    transmissionFilter,
    fuelFilter,
    powertrainFilter,
    driveTypeFilter,
    selectedDate,
    sortInfo,
    pagination.current,
    pagination.pageSize,
    navigate,
    location.pathname,
    location.search,
  ]);

  // Debounced URL update
  useEffect(() => {
    const timer = setTimeout(updateUrl, 300);
    return () => clearTimeout(timer);
  }, [updateUrl]);

  // Load index data on mount
  useEffect(() => {
    let cancelled = false;

    const loadIndex = async () => {
      try {
        const data = await fetchFreshJson<IndexData>(DATA_URLS.index);
        if (!cancelled) {
          setIndexData(data);
        }
      } catch (error) {
        if (!cancelled) {
          console.warn('Failed to load index:', error);
        }
      }
    };
    loadIndex();

    return () => { cancelled = true; };
  }, []);

  // Update available dates when brand or index changes
  useEffect(() => {
    if (indexData) {
      let dates: string[] = [];

      if (selectedBrand === 'all') {
        // For "all" brands, collect all unique dates from all brands
        const allDatesSet = new Set<string>();
        Object.values(indexData.brands).forEach((brand) => {
          brand.availableDates.forEach((date) => allDatesSet.add(date));
        });
        dates = Array.from(allDatesSet).sort((a, b) => b.localeCompare(a)); // Sort descending (newest first)
      } else if (indexData.brands[selectedBrand]) {
        dates = indexData.brands[selectedBrand].availableDates;
      }

      setAvailableDates(dates);

      // Set date from URL or auto-select latest (dates[0] is newest)
      if (initialUrlState.date && !urlInitialized.current) {
        const urlDate = dayjs(initialUrlState.date);
        if (dates.includes(urlDate.format('YYYY-MM-DD'))) {
          setSelectedDate(urlDate);
        } else if (dates.length > 0) {
          setSelectedDate(dayjs(dates[0]));
        }
      } else if (dates.length > 0) {
        // Check if current selected date is valid for this brand
        const currentDateStr = selectedDate?.format('YYYY-MM-DD');
        if (!currentDateStr || !dates.includes(currentDateStr)) {
          // Auto-select latest available date for this brand
          setSelectedDate(dayjs(dates[0]));
        }
      } else {
        setSelectedDate(null);
      }

      urlInitialized.current = true;
    } else {
      setAvailableDates([]);
      if (!initialUrlState.date) {
        setSelectedDate(null);
      }
    }
  }, [indexData, selectedBrand]);

  // Load data when date changes
  useEffect(() => {
    if (!selectedDate) {
      // Show loading while index is still being fetched, error only after index loaded
      if (!indexData) {
        setFetchState({ loading: true, error: null, data: null });
      } else {
        setFetchState({ loading: false, error: t('errors.noData'), data: null });
      }
      return;
    }

    const controller = new AbortController();
    const { signal } = controller;

    const fetchData = async () => {
      setFetchState({ loading: true, error: null, data: null });

      try {
        const year = selectedDate.format('YYYY');
        const month = selectedDate.format('MM');
        const day = selectedDate.format('DD');

        if (selectedBrand === 'all') {
          // Fetch all brands via /latest endpoint (single request)
          const response = await fetch(DATA_URLS.latest, { signal });
          if (!response.ok) {
            throw new Error(t('errors.noData'));
          }

          const latestData = await response.json();
          const allRows: PriceListRow[] = [];
          let latestTimestamp = latestData.generatedAt || '';

          // Extract rows from all brands
          Object.values(latestData.brands || {}).forEach((brand: any) => {
            if (brand.vehicles) {
              allRows.push(...brand.vehicles);
            }
          });

          if (allRows.length === 0) {
            throw new Error(t('errors.noData'));
          }

          if (!signal.aborted) {
            setFetchState({
              loading: false,
              error: null,
              data: {
                rows: prepareRows(allRows),
                lastUpdated: latestTimestamp,
                brand: t('common.all'),
              },
            });
          }
        } else {
          // Fetch single brand
          const url = DATA_URLS.brandData(year, month, selectedBrand, day);
          const response = await fetch(url, { signal });
          if (!response.ok) {
            throw new Error(t('errors.noData'));
          }

          const storedData: StoredData = await response.json();
          if (!storedData || !Array.isArray(storedData.rows)) {
            throw new Error(t('errors.noData'));
          }

          if (!signal.aborted) {
            setFetchState({
              loading: false,
              error: null,
              data: {
                rows: prepareRows(storedData.rows),
                lastUpdated: storedData.collectedAt,
                brand: storedData.brand,
              },
            });
          }
        }
      } catch (error) {
        if ((error as Error).name !== 'AbortError' && !signal.aborted) {
          const errorMessage =
            error instanceof Error ? error.message : t('errors.fetchError');
          setFetchState({ loading: false, error: errorMessage, data: null });
        }
      }
    };

    fetchData();

    return () => controller.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate, selectedBrand, refetchTrigger, indexData]);

  // Filtered data
  const filteredData = useMemo(() => {
    if (!fetchState.data) return [];

    let result = fetchState.data.rows;

    // Global search
    if (searchText) {
      const search = searchText.toLowerCase();
      result = result.filter(
        (row) =>
          String(row.model || '').toLowerCase().includes(search) ||
          String(row.trim || '').toLowerCase().includes(search) ||
          String(row.engine || '').toLowerCase().includes(search) ||
          String(row.transmission || '').toLowerCase().includes(search)
      );
    }

    // Model filter
    if (modelFilter) {
      result = result.filter((row) => row.model === modelFilter);
    }

    // Transmission filter
    if (transmissionFilter) {
      result = result.filter((row) => row.transmission === transmissionFilter);
    }

    // Fuel filter
    if (fuelFilter) {
      result = result.filter((row) => row.fuel === fuelFilter);
    }

    // Powertrain filter
    if (powertrainFilter) {
      result = result.filter((row) => {
        switch (powertrainFilter) {
          case 'electric':
            return row.isElectric === true;
          case 'pluginHybrid':
            return row.isPlugInHybrid === true;
          case 'mildHybrid':
            return row.isMildHybrid === true;
          case 'hybrid':
            return row.isHybrid === true && !row.isPlugInHybrid && !row.isMildHybrid;
          case 'ice':
            return !row.isElectric && !row.isHybrid && !row.isPlugInHybrid && !row.isMildHybrid;
          default:
            return true;
        }
      });
    }

    // Drive type filter
    if (driveTypeFilter) {
      result = result.filter((row) => row.driveType === driveTypeFilter);
    }

    // Price range filter
    if (priceRange) {
      result = result.filter((row) => {
        const price = row.priceNumeric || 0;
        return price >= priceRange[0] && price <= priceRange[1];
      });
    }

    // Power range filter
    if (powerRange) {
      result = result.filter((row) => {
        const power = row.powerHP || 0;
        return power >= powerRange[0] && power <= powerRange[1];
      });
    }

    return result;
  }, [fetchState.data, searchText, modelFilter, transmissionFilter, fuelFilter, powertrainFilter, driveTypeFilter, priceRange, powerRange]);

  // Get unique values for filters
  const modelOptions = useMemo(() => {
    if (!fetchState.data) return [];
    const models = [...new Set(fetchState.data.rows.map((row) => row.model))];
    return models.filter(Boolean).sort();
  }, [fetchState.data]);

  const transmissionOptions = useMemo(() => {
    if (!fetchState.data) return [];
    const transmissions = [...new Set(fetchState.data.rows.map((row) => row.transmission))];
    return transmissions.filter(Boolean).sort();
  }, [fetchState.data]);

  const fuelOptions = useMemo(() => {
    if (!fetchState.data) return [];
    const fuels = [...new Set(fetchState.data.rows.map((row) => row.fuel))];
    return fuels.filter(Boolean).sort();
  }, [fetchState.data]);

  // Powertrain options based on available data
  const powertrainOptions = useMemo(() => {
    if (!fetchState.data) return [];
    const options: { value: string; label: string; count: number }[] = [];

    const rows = fetchState.data.rows;
    const electricCount = rows.filter(r => r.isElectric).length;
    const pluginCount = rows.filter(r => r.isPlugInHybrid).length;
    const mildCount = rows.filter(r => r.isMildHybrid).length;
    const hybridCount = rows.filter(r => r.isHybrid && !r.isPlugInHybrid && !r.isMildHybrid).length;
    const iceCount = rows.filter(r => !r.isElectric && !r.isHybrid && !r.isPlugInHybrid && !r.isMildHybrid).length;

    if (electricCount > 0) options.push({ value: 'electric', label: `Elektrikli (${electricCount})`, count: electricCount });
    if (pluginCount > 0) options.push({ value: 'pluginHybrid', label: `Plug-in Hybrid (${pluginCount})`, count: pluginCount });
    if (mildCount > 0) options.push({ value: 'mildHybrid', label: `Mild Hybrid (${mildCount})`, count: mildCount });
    if (hybridCount > 0) options.push({ value: 'hybrid', label: `Hybrid (${hybridCount})`, count: hybridCount });
    if (iceCount > 0) options.push({ value: 'ice', label: `Benzin/Dizel (${iceCount})`, count: iceCount });

    return options;
  }, [fetchState.data]);

  // Drive type options based on available data
  const driveTypeOptions = useMemo(() => {
    if (!fetchState.data) return [];
    const driveTypes: { [key: string]: number } = {};

    fetchState.data.rows.forEach(row => {
      if (row.driveType) {
        driveTypes[row.driveType] = (driveTypes[row.driveType] || 0) + 1;
      }
    });

    const labels: { [key: string]: string } = {
      'AWD': t('common.driveTypes.awd'),
      'FWD': t('common.driveTypes.fwd'),
      'RWD': t('common.driveTypes.rwd'),
    };

    return Object.entries(driveTypes).map(([type, count]) => ({
      value: type,
      label: `${labels[type] || type} (${count})`,
      count,
    }));
  }, [fetchState.data, t]);

  // Price and Power bounds for sliders
  const priceBounds = useMemo(() => {
    if (!fetchState.data) return { min: 0, max: 10000000 };
    const prices = fetchState.data.rows.map(r => r.priceNumeric).filter(p => p > 0);
    if (prices.length === 0) return { min: 0, max: 10000000 };
    return {
      min: Math.floor(Math.min(...prices) / 100000) * 100000,
      max: Math.ceil(Math.max(...prices) / 100000) * 100000,
    };
  }, [fetchState.data]);

  const powerBounds = useMemo(() => {
    if (!fetchState.data) return { min: 0, max: 500 };
    const powers = fetchState.data.rows.map(r => r.powerHP || 0).filter(p => p > 0);
    if (powers.length === 0) return { min: 0, max: 500 };
    return {
      min: Math.floor(Math.min(...powers) / 10) * 10,
      max: Math.ceil(Math.max(...powers) / 10) * 10,
    };
  }, [fetchState.data]);

  // Reset range filters when bounds change (prevents stale filters)
  useEffect(() => {
    // Always reset price range when bounds change to ensure filter consistency
    setPriceRange(null);
  }, [priceBounds.min, priceBounds.max]);

  useEffect(() => {
    // Always reset power range when bounds change
    setPowerRange(null);
  }, [powerBounds.min, powerBounds.max]);

  // Handle favorite toggle
  const handleFavoriteToggle = (row: PriceListRow) => {
    const vehicle = createVehicleIdentifier(row.brand, row.model, row.trim, row.engine);
    if (isFavorite(vehicle.id)) {
      removeFavorite(vehicle.id);
      message.info(t('common.remove'));
    } else {
      addFavorite(vehicle);
      message.success(t('priceList.addToFavorites'));
    }
  };

  // Handle compare toggle
  const handleCompareToggle = (row: PriceListRow) => {
    const vehicle = createVehicleIdentifier(row.brand, row.model, row.trim, row.engine);
    if (isInCompare(vehicle.id)) {
      removeFromCompare(vehicle.id);
      message.info(t('common.remove'));
    } else {
      if (addToCompare(vehicle)) {
        message.success(t('priceList.addToCompare'));
      } else {
        message.warning(t('comparison.compareList.maxReached'));
      }
    }
  };

  // Handle track toggle
  const handleTrackToggle = (row: PriceListRow) => {
    const id = createVehicleId(row.brand, row.model, row.trim, row.engine);
    if (isTracked(id)) {
      removeTrackedVehicle(id);
      message.info(t('priceList.untrack'));
    } else {
      const trackedVehicle: TrackedVehicle = {
        id,
        brand: row.brand,
        model: row.model,
        trim: row.trim,
        engine: row.engine,
        lastPrice: row.priceNumeric,
        lastPriceRaw: row.priceRaw,
        lastCheckDate: new Date().toISOString(),
      };
      addTrackedVehicle(trackedVehicle);
      message.success(t('priceList.track'));
    }
  };

  // Handle trend view
  const handleViewTrend = (row: PriceListRow) => {
    setTrendVehicle(row);
    setTrendModalOpen(true);
  };

  // Handle copy link
  const handleCopyLink = async () => {
    const state: PriceListUrlState = {
      brand: selectedBrand,
      q: searchText || undefined,
      model: modelFilter || undefined,
      transmission: transmissionFilter || undefined,
      fuel: fuelFilter || undefined,
      powertrain: powertrainFilter || undefined,
      driveType: driveTypeFilter || undefined,
      date: selectedDate?.format('YYYY-MM-DD'),
      sort: sortInfo ? `${sortInfo.column}:${sortInfo.order === 'descend' ? 'desc' : 'asc'}` : undefined,
      page: pagination.current,
      pageSize: pagination.pageSize,
    };

    const url = getShareableUrl(state);
    const success = await copyUrlToClipboard(url);

    if (success) {
      message.success(t('priceList.linkCopied'));
    } else {
      message.error(t('errors.fetchError'));
    }
  };

  // Handle table change (pagination, sort)
  const handleTableChange = (
    newPagination: TablePaginationConfig,
    _filters: any,
    sorter: SorterResult<PriceListRow> | SorterResult<PriceListRow>[]
  ) => {
    setPagination(newPagination);

    const singleSorter = Array.isArray(sorter) ? sorter[0] : sorter;
    if (singleSorter.column) {
      setSortInfo({
        column: singleSorter.columnKey as string,
        order: singleSorter.order || 'ascend',
      });
    }
  };

  // Table columns
  const columns: ColumnsType<PriceListRow> = useMemo(() => {
    const baseColumns: ColumnsType<PriceListRow> = [
      {
        title: t('common.model'),
        dataIndex: 'model',
        key: 'model',
        width: isMobile ? 100 : 180,
        fixed: isMobile ? undefined : 'left',
        sorter: (a, b) => a.model.localeCompare(b.model, 'tr'),
        sortOrder: sortInfo?.column === 'model' ? sortInfo.order : undefined,
        render: (text, record) => {
          const yearStr = record.modelYear ? String(record.modelYear) : '';
          const showYearBadge = record.modelYear && !text.includes(yearStr);

          return (
            <Space size={4}>
              <Text strong style={{ color: tokens.colors.accent, fontSize: isMobile ? 12 : 14 }}>
                {text}
              </Text>
              {showYearBadge && (
                <Tag color="blue" style={{ marginLeft: 2, fontSize: isMobile ? 9 : 10, padding: isMobile ? '0 3px' : undefined }}>
                  {record.modelYear}
                </Tag>
              )}
            </Space>
          );
        },
      },
      {
        title: t('common.trim'),
        dataIndex: 'trim',
        key: 'trim',
        width: isMobile ? 120 : 200,
        sorter: (a, b) => a.trim.localeCompare(b.trim, 'tr'),
        sortOrder: sortInfo?.column === 'trim' ? sortInfo.order : undefined,
        render: (text) => (
          <span style={{ fontSize: isMobile ? 12 : 14 }}>{text}</span>
        ),
      },
    ];

    // Engine and Transmission columns - hide on mobile
    if (!isMobile) {
      baseColumns.push(
        {
          title: t('common.engine'),
          dataIndex: 'engine',
          key: 'engine',
          width: 150,
          sorter: (a, b) => a.engine.localeCompare(b.engine, 'tr'),
          sortOrder: sortInfo?.column === 'engine' ? sortInfo.order : undefined,
        },
        {
          title: t('common.transmission'),
          dataIndex: 'transmission',
          key: 'transmission',
          width: 140,
          sorter: (a, b) => a.transmission.localeCompare(b.transmission, 'tr'),
          sortOrder: sortInfo?.column === 'transmission' ? sortInfo.order : undefined,
          render: (text) =>
            text ? (
              <span style={transmissionBadgeStyle}>
                {text}
              </span>
            ) : (
              '-'
            ),
        }
      );
    }

    // Fuel column
    baseColumns.push({
      title: t('common.fuel'),
      dataIndex: 'fuel',
      key: 'fuel',
      width: isMobile ? 80 : 130,
      sorter: (a, b) => a.fuel.localeCompare(b.fuel, 'tr'),
      sortOrder: sortInfo?.column === 'fuel' ? sortInfo.order : undefined,
      render: (text) => {
        const fuelColors: { [key: string]: string } = {
          Benzin: tokens.colors.fuel.benzin,
          Dizel: tokens.colors.fuel.dizel,
          Elektrik: tokens.colors.fuel.elektrik,
          Hybrid: tokens.colors.fuel.hybrid,
          'Mild Hybrid': tokens.colors.fuel.hybrid,
          'Plug-in Hybrid': tokens.colors.fuel.pluginHybrid,
          LPG: tokens.colors.fuel.cng,
          CNG: tokens.colors.fuel.cng,
        };
        const shortNames: { [key: string]: string } = {
          Benzin: 'B',
          Dizel: 'D',
          Elektrik: 'E',
          Hybrid: 'H',
          'Mild Hybrid': 'MH',
          'Plug-in Hybrid': 'PH',
          LPG: 'LPG',
          CNG: 'C',
        };
        return text ? (
          <span
            style={{
              background: fuelColors[text] || tokens.colors.gray[400],
              color: '#fff',
              padding: isMobile ? '2px 6px' : '4px 12px',
              borderRadius: tokens.borderRadius.full,
              fontSize: isMobile ? 10 : 12,
              fontWeight: '500',
            }}
          >
            {isMobile ? shortNames[text] || text : text}
          </span>
        ) : (
          '-'
        );
      },
    });

    // Price column
    baseColumns.push({
      title: t('common.price'),
      dataIndex: 'priceRaw',
      key: 'price',
      width: isMobile ? 120 : 200,
      sorter: (a, b) => {
        // Use priceNumeric consistently with filtering
        const priceA = a.priceNumeric;
        const priceB = b.priceNumeric;
        return priceA - priceB;
      },
      sortOrder: sortInfo?.column === 'price' ? sortInfo.order : undefined,
      defaultSortOrder: 'ascend',
      render: (_, record) => {
        // Always use priceNumeric for display consistency with filtering
        // priceListNumeric may contain net prices (before taxes) which would cause display/filter mismatch
        const displayPrice = record.priceNumeric;
        const formattedPrice = isMobile
          ? (displayPrice / 1000000).toFixed(2).replace('.', ',') + 'M'
          : displayPrice.toLocaleString('tr-TR') + ' TL';

        // Discount = list price vs the actual selling price. Prefer an explicit
        // campaign price, otherwise fall back to the displayed (turnkey) price so a
        // discount still shows when the brand doesn't provide priceCampaignNumeric.
        // The `priceListNumeric > sellingPrice` guard keeps brands whose
        // priceListNumeric is a NET (pre-tax, lower) figure from showing a fake discount.
        const sellingPrice = record.priceCampaignNumeric ?? displayPrice;
        const hasDiscount = record.priceListNumeric != null && sellingPrice != null &&
          record.priceListNumeric > sellingPrice;

        const discountPercent = hasDiscount
          ? Math.round(((record.priceListNumeric! - sellingPrice) / record.priceListNumeric!) * 100)
          : 0;

        return (
          <Space direction="vertical" size={0}>
            <Space size={4}>
              <Text strong style={{ color: tokens.colors.success, fontSize: isMobile ? 12 : 14 }}>
                {formattedPrice}
              </Text>
              <PriceTrendBadge vehicle={record} compact showSparkline={!isMobile} />
            </Space>
            {hasDiscount && discountPercent > 0 && !isMobile && (
              <Tag color="green" style={discountTagStyle}>
                -{discountPercent}% indirim
              </Tag>
            )}
          </Space>
        );
      },
    });

    // Actions column
    baseColumns.push({
      title: '',
      key: 'actions',
      width: isMobile ? 70 : 160,
      fixed: isMobile ? undefined : 'right',
      render: (_, record) => {
        const vehicleId = createVehicleId(record.brand, record.model, record.trim, record.engine);
        const isFav = isFavorite(vehicleId);
        const isComp = isInCompare(vehicleId);
        const isTrack = isTracked(vehicleId);

        if (isMobile) {
          return (
            <Space size={0}>
              <Button
                type="text"
                size="small"
                icon={isFav ? <HeartFilled style={iconStyles.heart} /> : <HeartOutlined />}
                onClick={() => handleFavoriteToggle(record)}
              />
              <Button
                type="text"
                size="small"
                icon={<LineChartOutlined />}
                onClick={() => handleViewTrend(record)}
              />
            </Space>
          );
        }

        return (
          <Space size="small">
            <Tooltip title={isFav ? t('common.remove') : t('priceList.addToFavorites')}>
              <Button
                type="text"
                size="small"
                icon={isFav ? <HeartFilled style={iconStyles.heart} /> : <HeartOutlined />}
                onClick={() => handleFavoriteToggle(record)}
              />
            </Tooltip>
            <Tooltip
              title={
                isComp
                  ? t('common.remove')
                  : canAddToCompare()
                  ? t('priceList.addToCompare')
                  : t('comparison.compareList.maxReached')
              }
            >
              <Button
                type="text"
                size="small"
                icon={
                  isComp ? (
                    <CheckOutlined style={iconStyles.check} />
                  ) : (
                    <SwapOutlined />
                  )
                }
                onClick={() => handleCompareToggle(record)}
                disabled={!isComp && !canAddToCompare()}
              />
            </Tooltip>
            <Tooltip title={isTrack ? t('priceList.untrack') : t('priceList.track')}>
              <Button
                type="text"
                size="small"
                icon={
                  isTrack ? (
                    <EyeInvisibleOutlined style={iconStyles.accent} />
                  ) : (
                    <EyeOutlined />
                  )
                }
                onClick={() => handleTrackToggle(record)}
              />
            </Tooltip>
            <Tooltip title={t('priceList.viewTrend')}>
              <Button
                type="text"
                size="small"
                icon={<LineChartOutlined />}
                onClick={() => handleViewTrend(record)}
              />
            </Tooltip>
          </Space>
        );
      },
    });

    return baseColumns;
  }, [isMobile, sortInfo, t, isFavorite, isInCompare, isTracked, canAddToCompare]);

  // Export handlers
  const handleExportCSV = () => {
    if (filteredData.length === 0) {
      message.warning(t('common.noData'));
      return;
    }
    exportToCSV(filteredData);
    message.success(t('priceList.export.csv'));
  };

  const handleExportXLSX = () => {
    if (filteredData.length === 0) {
      message.warning(t('common.noData'));
      return;
    }
    exportToXLSX(filteredData);
    message.success(t('priceList.export.excel'));
  };

  const handleCopyMarkdown = async () => {
    if (filteredData.length === 0) {
      message.warning(t('common.noData'));
      return;
    }
    const success = await copyAsMarkdown(filteredData);
    if (success) {
      message.success(t('priceList.export.markdown'));
    } else {
      message.error(t('errors.fetchError'));
    }
  };

  // Clear filters on brand change
  const handleBrandChange = (brand: string) => {
    setSelectedBrand(brand);
    setSearchText('');
    setModelFilter(null);
    setTransmissionFilter(null);
    setFuelFilter(null);
    setPowertrainFilter(null);
    setDriveTypeFilter(null);
    setPriceRange(null);
    setPowerRange(null);
  };

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
          {t('priceList.title')}
        </Title>
        <Text type="secondary">
          {fetchState.data
            ? `${filteredData.length} ${t('common.records')}`
            : t('common.loading')}
        </Text>
      </motion.div>

      {/* Controls */}
      <motion.div
        variants={staggerItem}
        style={cardStyle}
      >
        <Space wrap size="middle" style={fullWidthStyle}>
          <div style={{ minWidth: isMobile ? '100%' : 'auto' }}>
            <Text strong style={labelStyle}>
              {t('common.brand')}:
            </Text>
            <Select
              showSearch
              value={selectedBrand}
              onChange={handleBrandChange}
              style={{ width: isMobile ? '100%' : 180, minWidth: isMobile ? 0 : 180 }}
              size={isMobile ? 'middle' : 'large'}
              optionFilterProp="label"
              filterOption={(input, option) =>
                (option?.label ?? '').toString().toLowerCase().includes(input.toLowerCase())
              }
              options={[
                { label: t('common.all'), value: 'all' },
                ...[...BRANDS].sort((a, b) => a.name.localeCompare(b.name, 'tr')).map((b) => ({ label: b.name, value: b.id }))
              ]}
            />
          </div>
          <div style={{ minWidth: isMobile ? '100%' : 'auto' }}>
            <Text strong style={labelStyle}>
              <CalendarOutlined /> {t('common.date')}:
            </Text>
            <DatePicker
              value={selectedDate}
              onChange={setSelectedDate}
              size={isMobile ? 'middle' : 'large'}
              format="DD/MM/YYYY"
              placeholder={t('common.date')}
              disabledDate={(current) => {
                const dateStr = current.format('YYYY-MM-DD');
                return !availableDates.includes(dateStr);
              }}
              style={{ width: isMobile ? '100%' : 150 }}
            />
          </div>
          <Button
            icon={<ReloadOutlined />}
            onClick={handleRefresh}
            loading={fetchState.loading}
            size={isMobile ? 'middle' : 'large'}
            type="primary"
            disabled={!selectedDate}
          >
            {isMobile ? '' : t('common.refresh')}
          </Button>
          {!isMobile && (
            <Tooltip title={t('priceList.copyLink')}>
              <Button
                icon={<LinkOutlined />}
                onClick={handleCopyLink}
                size="large"
              >
                {t('priceList.copyLink')}
              </Button>
            </Tooltip>
          )}
        </Space>

        {fetchState.data?.lastUpdated && (
          <div style={{ marginTop: tokens.spacing.md }}>
            <Text type="secondary" style={{ fontSize: '13px' }}>
              {t('priceList.dataDate')}: {dayjs(fetchState.data.lastUpdated).format('DD/MM/YYYY HH:mm')}
            </Text>
          </div>
        )}
      </motion.div>

      {/* Brand Disclaimer */}
      {fetchState.data && (
        <motion.div variants={staggerItem}>
          <BrandDisclaimer
            brandName={BRANDS.find(b => b.id === selectedBrand)?.name || selectedBrand}
            lastUpdated={fetchState.data.lastUpdated ? dayjs(fetchState.data.lastUpdated).format('DD/MM/YYYY') : undefined}
            variant="compact"
          />
        </motion.div>
      )}

      {/* Error */}
      {fetchState.error && !fetchState.loading && (
        <motion.div variants={staggerItem}>
          <Alert
            message={t('common.error')}
            description={fetchState.error}
            type="error"
            showIcon
            closable
            style={{ marginBottom: tokens.spacing.lg }}
            action={
              <Button size="small" onClick={handleRefresh}>
                {t('errors.tryAgain')}
              </Button>
            }
          />
        </motion.div>
      )}

      {/* Loading */}
      {fetchState.loading && (
        <motion.div
          variants={staggerItem}
          style={loadingCenterStyle}
        >
          <Spin size="large" />
        </motion.div>
      )}

      {/* Data loaded */}
      {!fetchState.loading && fetchState.data && (
        <>
          {/* Filters */}
          <motion.div
            variants={staggerItem}
            style={cardStyle}
          >
            <Text strong style={sectionTitleStyle}>
              {t('priceList.filters.title')}
            </Text>
            <Space wrap size={isMobile ? 'small' : 'middle'} style={fullWidthStyle}>
              <Search
                placeholder={t('priceList.filters.searchPlaceholder')}
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                style={{ width: isMobile ? '100%' : 300, minWidth: isMobile ? 200 : 300 }}
                size={isMobile ? 'middle' : 'large'}
                prefix={<SearchOutlined />}
                allowClear
              />
              <Select
                placeholder={t('priceList.filters.selectModel')}
                value={modelFilter}
                onChange={setModelFilter}
                style={{ width: isMobile ? 140 : 180 }}
                size={isMobile ? 'middle' : 'large'}
                allowClear
                options={modelOptions.map((m) => ({ label: m, value: m }))}
              />
              <Select
                placeholder={t('priceList.filters.selectTransmission')}
                value={transmissionFilter}
                onChange={setTransmissionFilter}
                style={{ width: isMobile ? 120 : 150 }}
                size={isMobile ? 'middle' : 'large'}
                allowClear
                options={transmissionOptions.map((tr) => ({ label: tr, value: tr }))}
              />
              <Select
                placeholder={t('priceList.filters.selectFuel')}
                value={fuelFilter}
                onChange={setFuelFilter}
                style={{ width: isMobile ? 120 : 150 }}
                size={isMobile ? 'middle' : 'large'}
                allowClear
                options={fuelOptions.map((f) => ({ label: f, value: f }))}
              />
              {powertrainOptions.length > 0 && (
                <Select
                  placeholder={t('priceList.filters.selectPowertrain', 'Güç Aktarımı')}
                  value={powertrainFilter}
                  onChange={setPowertrainFilter}
                  style={{ width: isMobile ? 140 : 180 }}
                  size={isMobile ? 'middle' : 'large'}
                  allowClear
                  options={powertrainOptions}
                />
              )}
              {driveTypeOptions.length > 0 && (
                <Select
                  placeholder={t('priceList.filters.selectDriveType', 'Çekiş Tipi')}
                  value={driveTypeFilter}
                  onChange={setDriveTypeFilter}
                  style={{ width: isMobile ? 140 : 180 }}
                  size={isMobile ? 'middle' : 'large'}
                  allowClear
                  options={driveTypeOptions}
                />
              )}
            </Space>

            {/* Range Sliders */}
            <Row gutter={[16, 8]} style={{ marginTop: tokens.spacing.md }}>
              <Col xs={24} md={12}>
                <div style={sliderPadStyle}>
                  <Text type="secondary" style={sliderLabelStyle}>
                    {t('priceList.filters.priceRange', 'Fiyat Aralığı')}: {' '}
                    {priceRange
                      ? `${(priceRange[0] / 1000000).toFixed(1)}M - ${(priceRange[1] / 1000000).toFixed(1)}M TL`
                      : t('common.all', 'Hepsi')}
                  </Text>
                  <Slider
                    range
                    min={priceBounds.min}
                    max={priceBounds.max}
                    step={100000}
                    value={priceRange || [priceBounds.min, priceBounds.max]}
                    onChange={(value) => setPriceRange(value as [number, number])}
                    tooltip={{
                      formatter: (value) => value ? `${(value / 1000000).toFixed(1)}M TL` : '',
                    }}
                  />
                </div>
              </Col>
              {powerBounds.max > 0 && (
                <Col xs={24} md={12}>
                  <div style={{ padding: '0 8px' }}>
                    <Text type="secondary" style={{ fontSize: 12, marginBottom: 4, display: 'block' }}>
                      {t('priceList.filters.powerRange', 'Güç Aralığı')}: {' '}
                      {powerRange
                        ? `${powerRange[0]} - ${powerRange[1]} HP`
                        : t('common.all', 'Hepsi')}
                    </Text>
                    <Slider
                      range
                      min={powerBounds.min}
                      max={powerBounds.max}
                      step={10}
                      value={powerRange || [powerBounds.min, powerBounds.max]}
                      onChange={(value) => setPowerRange(value as [number, number])}
                      tooltip={{
                        formatter: (value) => value ? `${value} HP` : '',
                      }}
                    />
                  </div>
                </Col>
              )}
            </Row>
          </motion.div>

          {/* Export buttons */}
          <motion.div
            variants={staggerItem}
            style={{
              background: tokens.colors.surface,
              padding: tokens.spacing.lg,
              borderRadius: tokens.borderRadius.lg,
              marginBottom: tokens.spacing.lg,
              borderLeft: `4px solid ${tokens.colors.accent}`,
            }}
          >
            <Text strong style={sectionTitleStyle}>
              {t('priceList.export.title')}
            </Text>
            <Space wrap size={isMobile ? 'small' : 'middle'}>
              <Button icon={<DownloadOutlined />} onClick={handleExportCSV} size={isMobile ? 'middle' : 'large'}>
                {isMobile ? 'CSV' : t('priceList.export.csv')}
              </Button>
              <Button icon={<DownloadOutlined />} onClick={handleExportXLSX} size={isMobile ? 'middle' : 'large'}>
                {isMobile ? 'XLSX' : t('priceList.export.excel')}
              </Button>
              <Button icon={<CopyOutlined />} onClick={handleCopyMarkdown} size={isMobile ? 'middle' : 'large'}>
                {isMobile ? 'MD' : t('priceList.export.markdown')}
              </Button>
            </Space>
          </motion.div>

          {/* Table */}
          <motion.div
            variants={tableRowVariants}
            style={{
              background: '#fff',
              borderRadius: tokens.borderRadius.lg,
              overflow: isMobile ? 'auto' : 'hidden',
              boxShadow: tokens.shadows.sm,
            }}
          >
<Table
              columns={columns}
              dataSource={filteredData}
              rowKey="_rowKey"
              pagination={pagination}
              onChange={handleTableChange}
              scroll={{ x: isMobile ? 500 : 1200, y: isMobile ? undefined : 600 }}
              size={isMobile ? 'small' : 'middle'}
              virtual={!isMobile}
              expandable={{
                columnWidth: 32,
                expandedRowRender: (record) => {
                  // Check if there's a discount (campaign price lower than list price)
                  const hasDiscount = record.priceListNumeric && record.priceCampaignNumeric &&
                    record.priceListNumeric > record.priceCampaignNumeric;
                  const discountAmount = hasDiscount
                    ? record.priceListNumeric! - record.priceCampaignNumeric!
                    : 0;

                  // Check for VW-specific extended data
                  const hasVWExtendedData = record.netPrice || record.otvAmount ||
                    record.kdvAmount || record.mtvAmount || record.origin ||
                    (record.optionalEquipment && record.optionalEquipment.length > 0);

                  // Check for powertrain/EV extended data
                  const hasPowertrainData = record.powerHP || record.powerKW || record.engineDisplacement ||
                    record.driveType || record.wltpRange || record.batteryCapacity ||
                    record.hasLongRange || record.isMildHybrid || record.isPlugInHybrid || record.isElectric || record.isHybrid;

                  const hasExtendedData = record.otvRate || record.fuelConsumption ||
                    record.monthlyLease || hasDiscount || hasVWExtendedData || hasPowertrainData;
                  if (!hasExtendedData) return null;

                  return (
                    <Descriptions size="small" column={{ xs: 1, sm: 2, md: 4 }} style={{ marginLeft: 16 }}>
                      {/* Powertrain & EV Section */}
                      {(record.powerHP || record.powerKW) && (
                        <Descriptions.Item label={t('priceList.power', 'Güç')}>
                          <Space size={4}>
                            {record.powerHP && <Tag color="blue">{record.powerHP} HP</Tag>}
                            {record.powerKW && <Tag color="geekblue">{record.powerKW} kW</Tag>}
                          </Space>
                        </Descriptions.Item>
                      )}
                      {record.engineDisplacement && (
                        <Descriptions.Item label={t('priceList.engineDisplacement', 'Motor Hacmi')}>
                          <Tag color="purple">{record.engineDisplacement}</Tag>
                        </Descriptions.Item>
                      )}
                      {record.driveType && (
                        <Descriptions.Item label={t('priceList.driveType', 'Çekiş')}>
                          <Tag color={record.driveType === 'AWD' ? 'blue' : record.driveType === 'RWD' ? 'orange' : 'green'}>
                            {t(`common.driveTypes.${record.driveType.toLowerCase()}`)}
                          </Tag>
                        </Descriptions.Item>
                      )}
                      {record.wltpRange && (
                        <Descriptions.Item label={t('priceList.wltpRange', 'WLTP Menzil')}>
                          <Tag color="green">{record.wltpRange} km</Tag>
                        </Descriptions.Item>
                      )}
                      {record.batteryCapacity && (
                        <Descriptions.Item label={t('priceList.batteryCapacity', 'Batarya')}>
                          <Tag color="cyan">{record.batteryCapacity} kWh</Tag>
                        </Descriptions.Item>
                      )}
                      {/* Powertrain type tags */}
                      {(record.hasLongRange || record.isMildHybrid || record.isPlugInHybrid || record.isElectric || record.isHybrid) && (
                        <Descriptions.Item label={t('priceList.powertrainType', 'Güç Aktarımı')}>
                          <Space wrap size="small">
                            {record.isElectric && <Tag color="green">Elektrikli</Tag>}
                            {record.isPlugInHybrid && <Tag color="lime">Plug-in Hybrid</Tag>}
                            {record.isMildHybrid && <Tag color="cyan">Mild Hybrid (48V)</Tag>}
                            {record.isHybrid && !record.isPlugInHybrid && !record.isMildHybrid && <Tag color="gold">Hybrid</Tag>}
                            {record.hasLongRange && <Tag color="purple">Uzun Menzil</Tag>}
                          </Space>
                        </Descriptions.Item>
                      )}

                      {/* Price & Tax Section */}
                      {hasDiscount && (
                        <Descriptions.Item label={t('priceList.campaignPrice', 'İndirimli Fiyat')}>
                          <Space direction="vertical" size={0}>
                            <Text strong style={{ color: tokens.colors.success, fontSize: 16 }}>
                              {record.priceCampaignNumeric!.toLocaleString('tr-TR')} TL
                            </Text>
                            <Text type="secondary" style={{ fontSize: 11 }}>
                              ({discountAmount.toLocaleString('tr-TR')} TL tasarruf)
                            </Text>
                          </Space>
                        </Descriptions.Item>
                      )}
                      {record.otvRate && (
                        <Descriptions.Item label={t('priceList.otvRate', 'ÖTV Oranı')}>
                          <Tag color="orange">%{record.otvRate}</Tag>
                        </Descriptions.Item>
                      )}
                      {record.netPrice && (
                        <Descriptions.Item label={t('priceList.netPrice', 'Net Fiyat (KDV Hariç)')}>
                          <Text type="secondary">{record.netPrice.toLocaleString('tr-TR')} TL</Text>
                        </Descriptions.Item>
                      )}
                      {record.otvAmount && (
                        <Descriptions.Item label={t('priceList.otvAmount', 'ÖTV Tutarı')}>
                          <Text style={{ color: '#fa8c16' }}>{record.otvAmount.toLocaleString('tr-TR')} TL</Text>
                        </Descriptions.Item>
                      )}
                      {record.kdvAmount && (
                        <Descriptions.Item label={t('priceList.kdvAmount', 'KDV Tutarı')}>
                          {record.kdvAmount.toLocaleString('tr-TR')} TL
                        </Descriptions.Item>
                      )}
                      {record.mtvAmount && (
                        <Descriptions.Item label={t('priceList.mtvAmount', 'MTV')}>
                          {record.mtvAmount.toLocaleString('tr-TR')} TL
                        </Descriptions.Item>
                      )}
                      {record.origin && (
                        <Descriptions.Item label={t('priceList.origin', 'Menşei')}>
                          <Tag color="blue">{record.origin}</Tag>
                        </Descriptions.Item>
                      )}
                      {record.optionalEquipment && record.optionalEquipment.length > 0 && (
                        <Descriptions.Item label={t('priceList.optionalEquipment', 'Opsiyonel Donanım')} span={2}>
                          <Space wrap size="small">
                            {record.optionalEquipment.map((opt, i) => (
                              <Tag key={i} color="cyan">
                                {opt.name}: +{opt.price.toLocaleString('tr-TR')} TL
                              </Tag>
                            ))}
                          </Space>
                        </Descriptions.Item>
                      )}
                      {record.fuelConsumption && (
                        <Descriptions.Item label={t('priceList.fuelConsumption', 'Yakıt Tüketimi')}>
                          {record.fuelConsumption}
                        </Descriptions.Item>
                      )}
                      {record.monthlyLease && (
                        <Descriptions.Item label={t('priceList.monthlyLease', 'Aylık Kira')}>
                          <Text strong style={{ color: tokens.colors.accent }}>
                            {record.monthlyLease.toLocaleString('tr-TR')} TL
                          </Text>
                        </Descriptions.Item>
                      )}
                    </Descriptions>
                  );
                },
                rowExpandable: (record) => {
                  const hasDiscount = record.priceListNumeric && record.priceCampaignNumeric &&
                    record.priceListNumeric > record.priceCampaignNumeric;
                  const hasVWExtendedData = record.netPrice || record.otvAmount ||
                    record.kdvAmount || record.mtvAmount || record.origin ||
                    (record.optionalEquipment && record.optionalEquipment.length > 0);
                  const hasPowertrainData = record.powerHP || record.powerKW || record.engineDisplacement ||
                    record.driveType || record.wltpRange || record.batteryCapacity ||
                    record.hasLongRange || record.isMildHybrid || record.isPlugInHybrid || record.isElectric || record.isHybrid;
                  return !!(record.otvRate || record.fuelConsumption || record.monthlyLease || hasDiscount || hasVWExtendedData || hasPowertrainData);
                },
              }}
            />
          </motion.div>
        </>
      )}

      {/* Trend Modal */}
      <PriceTrendModal
        open={trendModalOpen}
        onClose={() => setTrendModalOpen(false)}
        vehicle={trendVehicle}
      />
    </motion.div>
  );
}
