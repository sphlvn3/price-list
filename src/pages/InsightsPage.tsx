// Insights Page - Advanced Price Intelligence Module
// Shows deal scores, outliers, brand analysis, and price intelligence

import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import {
  Typography,
  Spin,
  Alert,
  Tabs,
  Card,
  Row,
  Col,
  Statistic,
  Select,
  Tag,
  Empty,
  Space,
} from 'antd';
import {
  TrophyOutlined,
  FallOutlined,
  RiseOutlined,
  BulbOutlined,
  FireOutlined,
  PercentageOutlined,
  BarChartOutlined,
  FilterOutlined,
  ThunderboltOutlined,
  DollarOutlined,
} from '@ant-design/icons';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ScatterChart,
  Scatter,
  ZAxis,
  Cell,
} from 'recharts';

import { tokens } from '../theme/tokens';
import { staggerContainer, staggerItem } from '../theme/animations';
import { fetchFreshJson, DATA_URLS } from '../utils/fetchData';
import DealScoreList from '../components/insights/DealScoreList';
import TodaysDeals from '../components/insights/TodaysDeals';
import OverpricedSection from '../components/insights/OverpricedSection';
import { ChartInfoTooltip, chartDescriptions } from '../components/common/ChartInfoTooltip';
import { useIsMobile } from '../hooks/useMediaQuery';

const { Title, Text } = Typography;

interface VehicleWithScore {
  id: string;
  brand: string;
  brandId: string;
  model: string;
  trim: string;
  engine: string;
  fuel: string;
  transmission: string;
  vehicleClass: string;
  priceBand: string;
  price: number;
  priceFormatted: string;
  dealScore: number;
  zScore: number;
  percentile: number;
  segmentAvg: number;
  segmentSize: number;
  isOutlier: boolean;
  outlierType: 'cheap' | 'expensive' | null;
  // Optional extended fields
  campaignDiscount?: number;
  otvRate?: number;
  modelYear?: number | string;
  fuelConsumption?: string;
  monthlyLease?: number;
}

interface InsightsData {
  generatedAt: string;
  date: string;
  topDeals: VehicleWithScore[];
  cheapOutliers: VehicleWithScore[];
  expensiveOutliers: VehicleWithScore[];
  allVehicles: VehicleWithScore[];
}

// Deal score color helper
const getScoreColor = (score: number): string => {
  if (score >= 80) return tokens.colors.success;
  if (score >= 60) return '#52c41a';
  if (score >= 40) return tokens.colors.warning;
  return tokens.colors.gray[400];
};

export default function InsightsPage() {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [insights, setInsights] = useState<InsightsData | null>(null);
  const [selectedBrand, setSelectedBrand] = useState<string>('all');
  const [selectedFuel, setSelectedFuel] = useState<string>('all');

  useEffect(() => {
    let cancelled = false;

    const fetchInsights = async () => {
      try {
        setLoading(true);
        const data = await fetchFreshJson<InsightsData>(DATA_URLS.insights);
        if (!cancelled) {
          setInsights(data);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Unknown error');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    fetchInsights();

    return () => {
      cancelled = true;
    };
  }, []);

  // Get unique brands and fuels
  const brands = useMemo(() => {
    if (!insights) return [];
    const brandSet = new Set(insights.allVehicles.map((v) => v.brand));
    return Array.from(brandSet).sort((a, b) => a.localeCompare(b, 'tr'));
  }, [insights]);

  const fuels = useMemo(() => {
    if (!insights) return [];
    const fuelSet = new Set(insights.allVehicles.map((v) => v.fuel));
    return Array.from(fuelSet).sort();
  }, [insights]);

  // Filter vehicles
  const filteredVehicles = useMemo(() => {
    if (!insights) return [];
    return insights.allVehicles.filter((v) => {
      if (selectedBrand !== 'all' && v.brand !== selectedBrand) return false;
      if (selectedFuel !== 'all' && v.fuel !== selectedFuel) return false;
      return true;
    });
  }, [insights, selectedBrand, selectedFuel]);

  const filteredTopDeals = useMemo(() => {
    if (!insights) return [];
    return insights.topDeals.filter((v) => {
      if (selectedBrand !== 'all' && v.brand !== selectedBrand) return false;
      if (selectedFuel !== 'all' && v.fuel !== selectedFuel) return false;
      return true;
    });
  }, [insights, selectedBrand, selectedFuel]);

  const filteredCheapOutliers = useMemo(() => {
    if (!insights) return [];
    return insights.cheapOutliers.filter((v) => {
      if (selectedBrand !== 'all' && v.brand !== selectedBrand) return false;
      if (selectedFuel !== 'all' && v.fuel !== selectedFuel) return false;
      return true;
    });
  }, [insights, selectedBrand, selectedFuel]);

  const filteredExpensiveOutliers = useMemo(() => {
    if (!insights) return [];
    return insights.expensiveOutliers.filter((v) => {
      if (selectedBrand !== 'all' && v.brand !== selectedBrand) return false;
      if (selectedFuel !== 'all' && v.fuel !== selectedFuel) return false;
      return true;
    });
  }, [insights, selectedBrand, selectedFuel]);

  // Summary statistics
  const summaryStats = useMemo(() => {
    if (!filteredVehicles.length) return null;

    const totalSavings = filteredVehicles
      .filter((v) => v.segmentAvg > v.price)
      .reduce((sum, v) => sum + (v.segmentAvg - v.price), 0);

    const avgDealScore = filteredVehicles.length
      ? filteredVehicles.reduce((sum, v) => sum + v.dealScore, 0) / filteredVehicles.length
      : 0;

    const dealsOver70 = filteredVehicles.filter((v) => v.dealScore >= 70).length;
    const dealsOver80 = filteredVehicles.filter((v) => v.dealScore >= 80).length;

    const dealsWithSavings = filteredVehicles.filter((v) => v.segmentAvg > v.price && v.segmentAvg > 0);
    const avgSavingsPercent = dealsWithSavings.length > 0
      ? dealsWithSavings.reduce((sum, v) => sum + ((v.segmentAvg - v.price) / v.segmentAvg) * 100, 0) / dealsWithSavings.length
      : 0;

    // Campaign discount stats
    const vehiclesWithCampaign = filteredVehicles.filter((v) => v.campaignDiscount && v.campaignDiscount > 0);
    const avgCampaignDiscount = vehiclesWithCampaign.length > 0
      ? vehiclesWithCampaign.reduce((sum, v) => sum + (v.campaignDiscount || 0), 0) / vehiclesWithCampaign.length
      : 0;

    return {
      totalVehicles: filteredVehicles.length,
      totalSavings,
      avgDealScore: Math.round(avgDealScore),
      dealsOver70,
      dealsOver80,
      avgSavingsPercent: Math.round(avgSavingsPercent),
      cheapOutliers: filteredCheapOutliers.length,
      expensiveOutliers: filteredExpensiveOutliers.length,
      vehiclesWithCampaign: vehiclesWithCampaign.length,
      avgCampaignDiscount: Math.round(avgCampaignDiscount * 10) / 10,
    };
  }, [filteredVehicles, filteredCheapOutliers, filteredExpensiveOutliers]);

  // Brand deal analysis
  const brandAnalysis = useMemo(() => {
    if (!insights) return [];

    const brandStats: { [key: string]: { total: number; scoreSum: number; deals: number } } = {};

    insights.allVehicles.forEach((v) => {
      if (!brandStats[v.brand]) {
        brandStats[v.brand] = { total: 0, scoreSum: 0, deals: 0 };
      }
      brandStats[v.brand].total += 1;
      brandStats[v.brand].scoreSum += v.dealScore;
      if (v.dealScore >= 70) brandStats[v.brand].deals += 1;
    });

    return Object.entries(brandStats)
      .map(([brand, stats]) => ({
        brand,
        avgScore: Math.round(stats.scoreSum / stats.total),
        deals: stats.deals,
        total: stats.total,
        dealPercent: Math.round((stats.deals / stats.total) * 100),
      }))
      .sort((a, b) => b.avgScore - a.avgScore);
  }, [insights]);

  // Deal score distribution
  const scoreDistribution = useMemo(() => {
    if (!filteredVehicles.length) return [];

    const bins = [
      { range: '0-20', min: 0, max: 20, count: 0, color: tokens.colors.error },
      { range: '20-40', min: 20, max: 40, count: 0, color: tokens.colors.warning },
      { range: '40-60', min: 40, max: 60, count: 0, color: tokens.colors.accent },
      { range: '60-80', min: 60, max: 80, count: 0, color: '#52c41a' },
      { range: '80-100', min: 80, max: 100, count: 0, color: tokens.colors.success },
    ];

    filteredVehicles.forEach((v) => {
      const bin = bins.find((b) => v.dealScore >= b.min && v.dealScore < b.max);
      if (bin) bin.count += 1;
      else if (v.dealScore === 100) bins[4].count += 1;
    });

    return bins;
  }, [filteredVehicles]);

  // Price deviation scatter data
  const priceDeviationData = useMemo(() => {
    if (!filteredVehicles.length) return [];

    return filteredVehicles.slice(0, 100).map((v) => ({
      brand: v.brand,
      model: `${v.brand} ${v.model}`,
      price: v.price,
      deviation: v.segmentAvg > 0 ? ((v.price - v.segmentAvg) / v.segmentAvg) * 100 : 0,
      dealScore: v.dealScore,
      segmentAvg: v.segmentAvg,
    }));
  }, [filteredVehicles]);

  // Fuel type deal analysis
  const fuelAnalysis = useMemo(() => {
    if (!insights) return [];

    const fuelStats: { [key: string]: { total: number; scoreSum: number; deals: number } } = {};

    insights.allVehicles.forEach((v) => {
      if (!fuelStats[v.fuel]) {
        fuelStats[v.fuel] = { total: 0, scoreSum: 0, deals: 0 };
      }
      fuelStats[v.fuel].total += 1;
      fuelStats[v.fuel].scoreSum += v.dealScore;
      if (v.dealScore >= 70) fuelStats[v.fuel].deals += 1;
    });

    return Object.entries(fuelStats)
      .map(([fuel, stats]) => ({
        fuel,
        avgScore: Math.round(stats.scoreSum / stats.total),
        deals: stats.deals,
        total: stats.total,
      }))
      .sort((a, b) => b.avgScore - a.avgScore);
  }, [insights]);

  const formatPrice = (value: number) => {
    return new Intl.NumberFormat('tr-TR', {
      style: 'currency',
      currency: 'TRY',
      maximumFractionDigits: 0,
    }).format(value);
  };

  const formatPriceShort = (value: number) => {
    if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
    return `${(value / 1000).toFixed(0)}K`;
  };

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

  if (error || !insights) {
    return (
      <div style={{ padding: tokens.spacing.lg }}>
        <Alert
          message={t('errors.fetchError')}
          description={error}
          type="error"
          showIcon
        />
      </div>
    );
  }

  const tabItems = [
    {
      key: 'overview',
      label: (
        <span>
          <BarChartOutlined /> {t('insights.tabs.overview', 'Genel Bakis')}
        </span>
      ),
      children: (
        <Row gutter={[24, 24]}>
          {/* Deal Score Distribution */}
          <Col xs={24} lg={12}>
            <Card
              title={t('insights.scoreDistribution', 'Fiyat Skoru Dagilimi')}
              extra={<ChartInfoTooltip {...chartDescriptions.scoreDistribution} />}
              style={{ borderRadius: tokens.borderRadius.lg }}
            >
              <ResponsiveContainer width="100%" height={isMobile ? 220 : 300}>
                <BarChart data={scoreDistribution}>
                  <CartesianGrid strokeDasharray="3 3" stroke={tokens.colors.gray[200]} />
                  <XAxis dataKey="range" fontSize={isMobile ? 10 : 12} />
                  <YAxis fontSize={isMobile ? 10 : 12} />
                  <Tooltip
                    formatter={(value: number) => [`${value} ${t('insights.vehicleCount')}`, t('insights.countLabel')]}
                    labelFormatter={(label) => `${t('insights.scoreLabel')}: ${label}`}
                  />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                    {scoreDistribution.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </Card>
          </Col>

          {/* Brand Deal Leaderboard */}
          <Col xs={24} lg={12}>
            <Card
              title={t('insights.brandLeaderboard', 'Marka Deger Siralaması')}
              extra={<ChartInfoTooltip {...chartDescriptions.brandLeaderboard} />}
              style={{ borderRadius: tokens.borderRadius.lg }}
            >
              <ResponsiveContainer width="100%" height={isMobile ? 220 : 300}>
                <BarChart data={brandAnalysis.slice(0, 10)} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke={tokens.colors.gray[200]} />
                  <XAxis type="number" domain={[0, 100]} fontSize={isMobile ? 10 : 12} />
                  <YAxis type="category" dataKey="brand" width={isMobile ? 60 : 80} fontSize={isMobile ? 10 : 12} />
                  <Tooltip
                    formatter={(value: number, name: string) => {
                      if (name === 'avgScore') return [`${value}`, t('insights.avgScore')];
                      return [value, name];
                    }}
                  />
                  <Bar dataKey="avgScore" fill={tokens.colors.accent} radius={[0, 4, 4, 0]}>
                    {brandAnalysis.slice(0, 10).map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={getScoreColor(entry.avgScore)} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </Card>
          </Col>

          {/* Price Deviation Scatter */}
          <Col span={24}>
            <Card
              title={t('insights.priceDeviation', 'Fiyat Sapma Analizi')}
              extra={
                <Space>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {t('insights.deviationExplanation', 'Negatif = Segment ortalamasinin altinda')}
                  </Text>
                  <ChartInfoTooltip {...chartDescriptions.priceDeviation} />
                </Space>
              }
              style={{ borderRadius: tokens.borderRadius.lg }}
            >
              <ResponsiveContainer width="100%" height={isMobile ? 280 : 400}>
                <ScatterChart margin={{ top: 20, right: isMobile ? 10 : 20, bottom: 20, left: isMobile ? 10 : 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={tokens.colors.gray[200]} />
                  <XAxis
                    type="number"
                    dataKey="price"
                    name={t('insights.priceLabel')}
                    tickFormatter={(v) => formatPriceShort(v)}
                    fontSize={isMobile ? 10 : 12}
                  />
                  <YAxis
                    type="number"
                    dataKey="deviation"
                    name={t('insights.deviationLabel')}
                    tickFormatter={(v) => `${Math.round(v)}%`}
                    domain={[-50, 50]}
                    fontSize={isMobile ? 10 : 12}
                  />
                  <ZAxis type="number" dataKey="dealScore" range={[50, 400]} name={t('insights.scoreLabel')} />
                  <Tooltip
                    cursor={{ strokeDasharray: '3 3' }}
                    formatter={(value: number, name: string) => {
                      if (name === t('insights.priceLabel')) return [formatPrice(value), name];
                      if (name === t('insights.deviationLabel')) return [`${value.toFixed(1)}%`, name];
                      return [value, name];
                    }}
                    labelFormatter={(_, payload) => {
                      if (payload && payload[0]) {
                        return payload[0].payload.model;
                      }
                      return '';
                    }}
                  />
                  <Scatter name={t('insights.vehicles')} data={priceDeviationData}>
                    {priceDeviationData.map((entry, index) => (
                      <Cell
                        key={`cell-${index}`}
                        fill={entry.deviation < 0 ? tokens.colors.success : tokens.colors.error}
                        fillOpacity={0.6}
                      />
                    ))}
                  </Scatter>
                </ScatterChart>
              </ResponsiveContainer>
            </Card>
          </Col>

          {/* Fuel Type Analysis */}
          <Col xs={24} md={12}>
            <Card
              title={t('insights.fuelAnalysis', 'Yakit Tipine Gore Deger')}
              extra={<ChartInfoTooltip {...chartDescriptions.fuelAnalysis} />}
              style={{ borderRadius: tokens.borderRadius.lg }}
            >
              {fuelAnalysis.map((item, index) => (
                <div
                  key={item.fuel}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: `${tokens.spacing.sm} 0`,
                    borderBottom:
                      index < fuelAnalysis.length - 1
                        ? `1px solid ${tokens.colors.gray[100]}`
                        : 'none',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing.sm }}>
                    <Tag color={getScoreColor(item.avgScore)}>{item.avgScore}</Tag>
                    <Text>{item.fuel}</Text>
                  </div>
                  <Text type="secondary">
                    {item.deals} / {item.total} {t('insights.opportunity')}
                  </Text>
                </div>
              ))}
            </Card>
          </Col>

          {/* Top Brands by Deal Count */}
          <Col xs={24} md={12}>
            <Card
              title={t('insights.topBrandsByDeals', 'En Cok Firsatli Markalar')}
              extra={<ChartInfoTooltip {...chartDescriptions.topBrandsByDeals} />}
              style={{ borderRadius: tokens.borderRadius.lg }}
            >
              {brandAnalysis
                .sort((a, b) => b.deals - a.deals)
                .slice(0, 8)
                .map((item, index) => (
                  <div
                    key={item.brand}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: `${tokens.spacing.sm} 0`,
                      borderBottom:
                        index < 7 ? `1px solid ${tokens.colors.gray[100]}` : 'none',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing.sm }}>
                      <Text strong style={{ width: 20 }}>
                        {index + 1}.
                      </Text>
                      <Text>{item.brand}</Text>
                    </div>
                    <div>
                      <Tag color="green">{item.deals} {t('insights.opportunity')}</Tag>
                      <Text type="secondary" style={{ marginLeft: 8 }}>
                        (%{item.dealPercent})
                      </Text>
                    </div>
                  </div>
                ))}
            </Card>
          </Col>
        </Row>
      ),
    },
    {
      key: 'deals',
      label: (
        <span>
          <TrophyOutlined /> {t('insights.bestDeals', 'En Iyi Firsatlar')} ({filteredTopDeals.length})
        </span>
      ),
      children: filteredTopDeals.length > 0 ? (
        <DealScoreList vehicles={filteredTopDeals} />
      ) : (
        <Empty description={t('insights.noDealsFound', 'Firsat bulunamadi')} />
      ),
    },
    {
      key: 'cheap',
      label: (
        <span>
          <FallOutlined /> {t('insights.todaysDeals', 'Gunun Firsatlari')} ({filteredCheapOutliers.length})
        </span>
      ),
      children: <TodaysDeals vehicles={filteredCheapOutliers} />,
    },
    {
      key: 'expensive',
      label: (
        <span>
          <RiseOutlined /> {t('insights.overpriced', 'Pahali Araclar')} ({filteredExpensiveOutliers.length})
        </span>
      ),
      children: <OverpricedSection vehicles={filteredExpensiveOutliers} />,
    },
  ];

  return (
    <motion.div
      variants={staggerContainer}
      initial="initial"
      animate="enter"
      style={{ padding: tokens.spacing.lg }}
    >
      {/* Header */}
      <motion.div variants={staggerItem} style={{ marginBottom: tokens.spacing.xl }}>
        <Title level={2} style={{ marginBottom: tokens.spacing.xs }}>
          <BulbOutlined style={{ marginRight: tokens.spacing.sm }} />
          {t('insights.title', 'Fiyat Istihbarati')}
        </Title>
        <Text type="secondary">
          {t('insights.subtitle', 'Yapay zeka destekli fiyat analizi ve firsat onerileri')}
        </Text>
      </motion.div>

      {/* Summary Stats */}
      <motion.div variants={staggerItem}>
        <Row gutter={[16, 16]} style={{ marginBottom: tokens.spacing.xl }}>
          <Col xs={12} sm={8} md={4}>
            <Card size="small" style={{ borderRadius: tokens.borderRadius.md }}>
              <Statistic
                title={t('insights.totalVehicles', 'Analiz Edilen')}
                value={summaryStats?.totalVehicles || 0}
                prefix={<BarChartOutlined />}
              />
            </Card>
          </Col>
          <Col xs={12} sm={8} md={4}>
            <Card size="small" style={{ borderRadius: tokens.borderRadius.md }}>
              <Statistic
                title={t('insights.avgScore', 'Ort. Skor')}
                value={summaryStats?.avgDealScore || 0}
                suffix="/ 100"
                valueStyle={{ color: getScoreColor(summaryStats?.avgDealScore || 0) }}
                prefix={<ThunderboltOutlined />}
              />
            </Card>
          </Col>
          <Col xs={12} sm={8} md={4}>
            <Card size="small" style={{ borderRadius: tokens.borderRadius.md }}>
              <Statistic
                title={t('insights.greatDeals', 'Iyi Firsatlar (70+)')}
                value={summaryStats?.dealsOver70 || 0}
                valueStyle={{ color: tokens.colors.success }}
                prefix={<FireOutlined />}
              />
            </Card>
          </Col>
          <Col xs={12} sm={8} md={4}>
            <Card size="small" style={{ borderRadius: tokens.borderRadius.md }}>
              <Statistic
                title={t('insights.excellentDeals', 'Mukemmel (80+)')}
                value={summaryStats?.dealsOver80 || 0}
                valueStyle={{ color: tokens.colors.success }}
                prefix={<TrophyOutlined />}
              />
            </Card>
          </Col>
          <Col xs={12} sm={8} md={4}>
            <Card size="small" style={{ borderRadius: tokens.borderRadius.md }}>
              <Statistic
                title={t('insights.avgSavings', 'Ort. Tasarruf')}
                value={summaryStats?.avgSavingsPercent || 0}
                suffix="%"
                valueStyle={{ color: tokens.colors.success }}
                prefix={<PercentageOutlined />}
              />
            </Card>
          </Col>
          <Col xs={12} sm={8} md={4}>
            <Card size="small" style={{ borderRadius: tokens.borderRadius.md }}>
              <Statistic
                title={t('insights.totalSavings', 'Toplam Potansiyel')}
                value={summaryStats?.totalSavings || 0}
                formatter={(v) => formatPriceShort(v as number)}
                valueStyle={{ color: tokens.colors.success }}
                prefix={<DollarOutlined />}
              />
            </Card>
          </Col>
          {(summaryStats?.vehiclesWithCampaign || 0) > 0 && (
            <Col xs={12} sm={8} md={4}>
              <Card size="small" style={{ borderRadius: tokens.borderRadius.md }}>
                <Statistic
                  title={t('insights.campaignVehicles')}
                  value={summaryStats?.vehiclesWithCampaign || 0}
                  suffix={summaryStats?.avgCampaignDiscount ? `(Ort. %${summaryStats.avgCampaignDiscount})` : ''}
                  valueStyle={{ color: '#52c41a' }}
                  prefix={<PercentageOutlined />}
                />
              </Card>
            </Col>
          )}
        </Row>
      </motion.div>

      {/* Filters */}
      <motion.div variants={staggerItem}>
        <Card
          size="small"
          style={{ marginBottom: tokens.spacing.lg, borderRadius: tokens.borderRadius.md }}
        >
          <Space wrap>
            <FilterOutlined />
            <Text strong>{t('common.filter', 'Filtre')}:</Text>
            <Select
              value={selectedBrand}
              onChange={setSelectedBrand}
              style={{ width: 150 }}
              options={[
                { label: t('common.all', 'Hepsi'), value: 'all' },
                ...brands.map((b) => ({ label: b, value: b })),
              ]}
              placeholder={t('common.brand', 'Marka')}
            />
            <Select
              value={selectedFuel}
              onChange={setSelectedFuel}
              style={{ width: 150 }}
              options={[
                { label: t('common.all', 'Hepsi'), value: 'all' },
                ...fuels.map((f) => ({ label: f, value: f })),
              ]}
              placeholder={t('common.fuel', 'Yakit')}
            />
          </Space>
        </Card>
      </motion.div>

      {/* Main Content */}
      <motion.div variants={staggerItem}>
        <Tabs
          items={tabItems}
          defaultActiveKey="overview"
          size="large"
          style={{
            background: tokens.colors.surface,
            padding: tokens.spacing.lg,
            borderRadius: tokens.borderRadius.lg,
          }}
        />
      </motion.div>

      {/* Data Info */}
      <motion.div variants={staggerItem}>
        <div style={{ marginTop: tokens.spacing.lg, textAlign: 'center' }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('insights.dataDate', 'Veri tarihi')}: {insights.date} |{' '}
            {t('insights.totalAnalyzed', 'Toplam analiz')}: {insights.allVehicles.length}{' '}
            {t('common.records', 'arac')}
          </Text>
        </div>
      </motion.div>
    </motion.div>
  );
}
