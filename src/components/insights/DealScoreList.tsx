// Deal Score List Component
// Shows top deals with scores and explanations

import { useTranslation } from 'react-i18next';
import { List, Card, Tag, Progress, Typography, Space, Button } from 'antd';
import {
  TrophyOutlined,
  HeartOutlined,
  HeartFilled,
  SwapOutlined,
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

interface DealScoreListProps {
  vehicles: VehicleWithScore[];
}

export default function DealScoreList({ vehicles }: DealScoreListProps) {
  const { t } = useTranslation();
  const { addFavorite, removeFavorite, isFavorite, addToCompare, isInCompare } = useAppStore();

  const getScoreColor = (score: number): string => {
    if (score >= 80) return tokens.colors.success;
    if (score >= 60) return '#52c41a';
    if (score >= 40) return tokens.colors.warning;
    return tokens.colors.gray[400];
  };

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

  const getDifferenceText = (vehicle: VehicleWithScore): string => {
    const diff = vehicle.segmentAvg - vehicle.price;
    const percent = vehicle.segmentAvg ? Math.round((diff / vehicle.segmentAvg) * 100) : 0;
    if (diff > 0) {
      return `${percent}% ${t('insights.belowAvg', 'below segment avg')}`;
    }
    return `${Math.abs(percent)}% ${t('insights.aboveAvg', 'above segment avg')}`;
  };

  return (
    <List
      dataSource={vehicles}
      renderItem={(vehicle, index) => (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: index * 0.05 }}
        >
          <Card
            style={{ marginBottom: tokens.spacing.md }}
            hoverable
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              {/* Left: Vehicle Info */}
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing.sm, marginBottom: tokens.spacing.xs }}>
                  {index < 3 && (
                    <TrophyOutlined
                      style={{
                        color: index === 0 ? '#ffd700' : index === 1 ? '#c0c0c0' : '#cd7f32',
                        fontSize: 20,
                      }}
                    />
                  )}
                  <Title level={5} style={{ marginBottom: 0 }}>
                    {vehicle.brand} {vehicle.model}
                  </Title>
                  <Tag color="blue">{vehicle.fuel}</Tag>
                  {vehicle.campaignDiscount && vehicle.campaignDiscount > 0 && (
                    <Tag color="green">-{vehicle.campaignDiscount.toFixed(1)}% {t('promos.campaign')}</Tag>
                  )}
                  {vehicle.otvRate && (
                    <Tag color="orange">{t('common.otvRate', { rate: vehicle.otvRate })}</Tag>
                  )}
                </div>

                <Text type="secondary" style={{ display: 'block', marginBottom: tokens.spacing.sm }}>
                  {vehicle.trim} | {vehicle.engine} | {vehicle.transmission}
                </Text>

                <Space>
                  <Text strong style={{ fontSize: 18, color: tokens.colors.primary }}>
                    {formatPrice(vehicle.price)}
                  </Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    ({getDifferenceText(vehicle)})
                  </Text>
                </Space>
              </div>

              {/* Right: Score and Actions */}
              <div style={{ textAlign: 'center', minWidth: 120 }}>
                <div style={{ marginBottom: tokens.spacing.sm }}>
                  <Progress
                    type="circle"
                    percent={vehicle.dealScore}
                    size={60}
                    strokeColor={getScoreColor(vehicle.dealScore)}
                    format={(percent) => (
                      <span style={{ fontSize: 14, fontWeight: 600 }}>{percent}</span>
                    )}
                  />
                  <div style={{ marginTop: 4 }}>
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      {t('insights.dealScore', 'Deal Score')}
                    </Text>
                  </div>
                </div>

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
  );
}
