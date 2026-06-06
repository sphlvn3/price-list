// Today's Deals Component
// Shows vehicles that are cheaper than expected (cheap outliers)

import { useTranslation } from 'react-i18next';
import { List, Card, Tag, Typography, Space, Button, Tooltip } from 'antd';
import {
  FallOutlined,
  HeartOutlined,
  HeartFilled,
  SwapOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';
import { motion } from 'framer-motion';

import { tokens } from '../../theme/tokens';
import { useAppStore, createVehicleIdentifier } from '../../store';

const { Text, Title } = Typography;

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

interface TodaysDealsProps {
  vehicles: VehicleWithScore[];
}

export default function TodaysDeals({ vehicles }: TodaysDealsProps) {
  const { t } = useTranslation();
  const { addFavorite, removeFavorite, isFavorite, addToCompare, isInCompare } = useAppStore();

  const handleFavoriteToggle = (vehicle: VehicleWithScore) => {
    const identifier = createVehicleIdentifier(
      vehicle.brand,
      vehicle.model,
      vehicle.trim,
      vehicle.engine
    );
    if (isFavorite(vehicle.id)) {
      removeFavorite(vehicle.id);
    } else {
      addFavorite(identifier);
    }
  };

  const handleCompareAdd = (vehicle: VehicleWithScore) => {
    const identifier = createVehicleIdentifier(
      vehicle.brand,
      vehicle.model,
      vehicle.trim,
      vehicle.engine
    );
    addToCompare(identifier);
  };

  const formatPrice = (price: number): string => {
    return new Intl.NumberFormat('tr-TR', {
      style: 'currency',
      currency: 'TRY',
      maximumFractionDigits: 0,
    }).format(price);
  };

  const getSavingsAmount = (vehicle: VehicleWithScore): number => {
    return vehicle.segmentAvg - vehicle.price;
  };

  const getSavingsPercent = (vehicle: VehicleWithScore): number => {
    if (!vehicle.segmentAvg) return 0; // avoid NaN/Infinity when segment avg is missing
    return Math.round((getSavingsAmount(vehicle) / vehicle.segmentAvg) * 100);
  };

  if (vehicles.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: tokens.spacing.xl }}>
        <FallOutlined style={{ fontSize: 48, color: tokens.colors.gray[300], marginBottom: 16 }} />
        <Title level={4} type="secondary">
          {t('insights.noDealsToday', 'No special deals found today')}
        </Title>
        <Text type="secondary">
          {t('insights.checkLater', 'Check back later for new deals')}
        </Text>
      </div>
    );
  }

  return (
    <div>
      <div style={{ marginBottom: tokens.spacing.md }}>
        <Space>
          <InfoCircleOutlined />
          <Text type="secondary">
            {t(
              'insights.dealsExplanation',
              'These vehicles are priced significantly below their segment average, making them potential great deals.'
            )}
          </Text>
        </Space>
      </div>

      <List
        dataSource={vehicles}
        renderItem={(vehicle, index) => (
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: index * 0.1 }}
          >
            <Card
              style={{
                marginBottom: tokens.spacing.md,
                borderLeft: `4px solid ${tokens.colors.success}`,
              }}
              hoverable
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                {/* Left: Vehicle Info */}
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing.sm, marginBottom: tokens.spacing.xs, flexWrap: 'wrap' }}>
                    <FallOutlined style={{ color: tokens.colors.success, fontSize: 18 }} />
                    <Title level={5} style={{ marginBottom: 0 }}>
                      {vehicle.brand} {vehicle.model}
                    </Title>
                    <Tag color="green">
                      -{getSavingsPercent(vehicle)}%
                    </Tag>
                    {vehicle.campaignDiscount && vehicle.campaignDiscount > 0 && (
                      <Tag color="cyan">{t('promos.campaign')} -%{vehicle.campaignDiscount.toFixed(1)}</Tag>
                    )}
                    {vehicle.otvRate && (
                      <Tag color="orange">{t('common.otvRate', { rate: vehicle.otvRate })}</Tag>
                    )}
                  </div>

                  <Text type="secondary" style={{ display: 'block', marginBottom: tokens.spacing.sm }}>
                    {vehicle.trim} | {vehicle.engine} | {vehicle.fuel}
                  </Text>

                  <Space direction="vertical" size={0}>
                    <Text strong style={{ fontSize: 18, color: tokens.colors.success }}>
                      {formatPrice(vehicle.price)}
                    </Text>
                    <Text type="secondary" style={{ fontSize: 12, textDecoration: 'line-through' }}>
                      {t('insights.segmentAvg', 'Segment avg')}: {formatPrice(vehicle.segmentAvg)}
                    </Text>
                  </Space>
                </div>

                {/* Right: Savings and Actions */}
                <div style={{ textAlign: 'center', minWidth: 140 }}>
                  <Tooltip title={t('insights.savingsTooltip', 'Compared to segment average')}>
                    <div
                      style={{
                        background: tokens.colors.success,
                        color: '#fff',
                        padding: '8px 16px',
                        borderRadius: tokens.borderRadius.md,
                        marginBottom: tokens.spacing.sm,
                      }}
                    >
                      <Text style={{ color: '#fff', fontSize: 12, display: 'block' }}>
                        {t('insights.youSave', 'You Save')}
                      </Text>
                      <Text style={{ color: '#fff', fontSize: 16, fontWeight: 600 }}>
                        {formatPrice(getSavingsAmount(vehicle))}
                      </Text>
                    </div>
                  </Tooltip>

                  <Space>
                    <Button
                      type="text"
                      size="small"
                      icon={isFavorite(vehicle.id) ? <HeartFilled style={{ color: tokens.colors.error }} /> : <HeartOutlined />}
                      onClick={() => handleFavoriteToggle(vehicle)}
                    />
                    <Button
                      type="text"
                      size="small"
                      icon={<SwapOutlined />}
                      disabled={isInCompare(vehicle.id)}
                      onClick={() => handleCompareAdd(vehicle)}
                    />
                  </Space>
                </div>
              </div>
            </Card>
          </motion.div>
        )}
      />
    </div>
  );
}
