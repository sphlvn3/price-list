/**
 * Price List Collector Script
 * Runs daily via GitHub Actions to collect and store price data
 *
 * Usage: npx tsx scripts/collect.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { XMLParser } from 'fast-xml-parser';
// @ts-ignore - pdf.js-extract types are incomplete
import { PDFExtract, PDFExtractResult, PDFExtractPage } from 'pdf.js-extract';
import * as cheerio from 'cheerio';
import { ErrorLogger } from './lib/errorLogger';
import { saveVehicleToMongo, disconnectMongo } from './lib/mongodb';

// Types
interface PriceListRow {
  // Core fields (required)
  model: string;
  trim: string;
  engine: string;
  transmission: string;
  fuel: string;
  priceRaw: string;
  priceNumeric: number;
  brand: string;

  // Extended fields (optional - available from some APIs)
  modelYear?: number | string;
  otvRate?: number;
  priceListNumeric?: number;
  priceCampaignNumeric?: number;
  fuelConsumption?: string;
  monthlyLease?: number;
}

interface BrandConfig {
  id: string;
  name: string;
  url: string;
  urls?: string[]; // Multiple URLs for brands with per-model pages (e.g., Opel)
  parser: 'vw' | 'skoda' | 'renault' | 'toyota' | 'hyundai' | 'fiat' | 'peugeot' | 'byd' | 'opel' | 'citroen' | 'bmw' | 'mercedes' | 'ford' | 'nissan' | 'honda' | 'seat' | 'kia' | 'volvo' | 'generic';
  responseType?: 'json' | 'xml' | 'pdf' | 'html';
}

interface CollectionResult {
  brand: string;
  success: boolean;
  count?: number;
  error?: string;
  usedFallback?: boolean;
  elapsed?: number;
}

interface IndexData {
  lastUpdated: string;
  brands: {
    [brandId: string]: {
      name: string;
      availableDates: string[];
      latestDate: string;
      totalRecords: number;
    };
  };
}

interface StoredData {
  collectedAt: string;
  brand: string;
  brandId: string;
  rowCount: number;
  rows: PriceListRow[];
}

// Fetch with timeout helper - wraps fetch with AbortController
async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 30_000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Timeout: fetch ${url} exceeded ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// Timeout wrapper for arbitrary promises (e.g., PDF extraction)
async function promiseWithTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`Timeout: ${label} (${timeoutMs}ms)`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timeoutId!));
}

// Dynamic URL extraction for Next.js sites (e.g., Citroen, Skoda)
async function extractNextJsBuildId(pageUrl: string): Promise<string | null> {
  try {
    const response = await fetchWithTimeout(pageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html',
      },
    });

    if (!response.ok) {
      console.log(`    Failed to fetch page for build ID: HTTP ${response.status}`);
      return null;
    }

    const html = await response.text();
    // Extract buildId from Next.js page - it's in the JSON embedded in the page
    const buildIdMatch = html.match(/"buildId"\s*:\s*"([^"]+)"/);
    if (buildIdMatch) {
      return buildIdMatch[1];
    }

    // Try alternative pattern
    const altMatch = html.match(/_next\/data\/([^/]+)\//);
    if (altMatch) {
      return altMatch[1];
    }

    console.log(`    Could not find buildId in page`);
    return null;
  } catch (error) {
    console.log(`    Error extracting buildId: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

// Brand configurations - Direct URLs (no CORS proxy needed in Node.js)
const BRANDS: BrandConfig[] = [
  {
    id: 'volkswagen',
    name: 'Volkswagen',
    url: 'https://binekarac2.vw.com.tr/app/local/fiyatlardata/fiyatlar-test.json?v=202511071652',
    parser: 'vw',
  },
  {
    id: 'skoda',
    name: 'Škoda',
    url: 'https://www.skoda.com.tr/fiyat-listesi',
    parser: 'skoda',
  },
  {
    id: 'renault',
    name: 'Renault',
    url: 'https://best.renault.com.tr/wp-json/service/v1/CatFiyatData?cat=Binek',
    parser: 'renault',
  },
  {
    id: 'toyota',
    name: 'Toyota',
    url: 'https://turkiye.toyota.com.tr/middle/fiyat-listesi/fiyat_v3.xml',
    parser: 'toyota',
    responseType: 'xml',
  },
  {
    id: 'hyundai',
    name: 'Hyundai',
    url: 'https://www.hyundai.com/wsvc/tr/spa/pricelist/list?loc=TR&lan=tr',
    parser: 'hyundai',
  },
  {
    id: 'fiat',
    name: 'Fiat',
    url: 'https://kampanya.fiat.com.tr/Pdf/Fiyatlar/OtomobilFiyatListesi.pdf',
    parser: 'fiat',
    responseType: 'pdf',
  },
  {
    id: 'peugeot',
    name: 'Peugeot',
    url: 'https://kampanya.peugeot.com.tr/fiyat-listesi/fiyatlar.pdf',
    parser: 'peugeot',
    responseType: 'pdf',
  },
  {
    id: 'byd',
    name: 'BYD',
    url: 'https://www.bydauto.com.tr/fiyat-listesi',
    parser: 'byd',
    responseType: 'html',
  },
  {
    id: 'opel',
    name: 'Opel',
    url: 'https://fiyatlisteleri.opel.com.tr',
    urls: [
      'https://fiyatlisteleri.opel.com.tr/arac/corsa',
      'https://fiyatlisteleri.opel.com.tr/arac/corsa-e',
      'https://fiyatlisteleri.opel.com.tr/arac/yeni-frontera-hybrid',
      'https://fiyatlisteleri.opel.com.tr/arac/frontera-elektrik',
      'https://fiyatlisteleri.opel.com.tr/arac/yeni-mokka',
      'https://fiyatlisteleri.opel.com.tr/arac/astra',
      'https://fiyatlisteleri.opel.com.tr/arac/astra-elektrik',
      'https://fiyatlisteleri.opel.com.tr/arac/yeni-grandland',
      'https://fiyatlisteleri.opel.com.tr/arac/yeni-grandland-elektrik',
    ],
    parser: 'opel',
    responseType: 'html',
  },
  {
    id: 'citroen',
    name: 'Citroën',
    url: 'https://talep.citroen.com.tr/fiyat-listesi', // Page URL for build ID extraction
    parser: 'citroen',
    responseType: 'json',
  },
  {
    id: 'bmw',
    name: 'BMW',
    url: 'https://www.borusanotomotiv.com/bmw/stage2/fiyat-listesi/static-fiyat-listesi-v2.aspx',
    parser: 'bmw',
    responseType: 'html',
  },
  {
    id: 'mercedes',
    name: 'Mercedes-Benz',
    url: 'https://pladmin.mercedes-benz.com.tr/api/product/searchByCategoryCode',
    urls: [
      // A-Class, CLA, AMG GT
      'w177-fl',   // A-Class
      'c118-fl',   // CLA Coupé
      'x118-fl',   // CLA Shooting Brake
      'x290-fl',   // AMG GT 4-Door
      // C-Class
      'w206',      // C-Class Sedan
      's206',      // C-Class Estate
      // E-Class
      'w214',      // E-Class Sedan
      'c236',      // E-Class Coupé
      'a236',      // E-Class Cabriolet
      // S-Class, Maybach
      'wv223',     // S-Class
      'z223',      // Mercedes-Maybach S-Class
      // EQ Electric
      'v295',      // EQE
      'v297',      // EQS
      // SUV
      'h243-fl',   // GLA
      'h247-fl',   // GLB
      'x247-fl',   // GLC (old)
      'x254',      // GLC (new)
      'c254',      // GLC Coupé
      'w465',      // G-Class
      // Sports / Luxury
      'r232',      // SL
      'z232',      // Mercedes-Maybach SL
      'c192',      // CLE Coupé
      'c174',      // B-Class
    ],
    parser: 'mercedes',
    responseType: 'json',
  },
  {
    id: 'ford',
    name: 'Ford',
    url: 'https://www.ford.com.tr/fwebapi/main/carPriceListNewUI?searchparam=&cartype=Binek',
    parser: 'ford',
    responseType: 'json',
  },
  {
    id: 'dacia',
    name: 'Dacia',
    url: 'https://best.renault.com.tr/wp-json/service/v1/CatFiyatData?brand=DACIA&cat=',
    parser: 'renault', // Same API structure as Renault
  },
  {
    id: 'nissan',
    name: 'Nissan',
    url: 'https://www.nissan.com.tr/fiyat-listesi/{year}-price-list.html', // {year} will be replaced dynamically
    parser: 'nissan',
    responseType: 'html',
  },
  {
    id: 'honda',
    name: 'Honda',
    url: 'https://www.honda.com.tr/otomobil/otomobil-fiyat-listesi-{year}', // {year} will be replaced dynamically
    parser: 'honda',
    responseType: 'html',
  },
  {
    id: 'seat',
    name: 'SEAT',
    url: 'https://www.seat.com.tr/firsatlar/fiyat-listesi',
    parser: 'seat',
    responseType: 'html',
  },
  {
    id: 'kia',
    name: 'Kia',
    url: 'https://www.kia.com/tr/satis-merkezi/fiyat-listesi.html',
    parser: 'kia',
    responseType: 'html',
  },
  {
    id: 'volvo',
    name: 'Volvo',
    url: 'https://www.volvocars.com/tr/l/fiyat-listesi/', // HTML page with dynamic PDF link
    parser: 'volvo',
    responseType: 'pdf', // Final response is PDF
  },
];

// Price validation constants (Turkish vehicle price range)
const MIN_VALID_PRICE = 100_000; // 100K TL - minimum realistic car price
const MAX_VALID_PRICE = 90_000_000; // 90M TL - maximum realistic car price

// Parse price string to number
const parsePrice = (priceStr: string): number => {
  if (!priceStr) return 0;
  const cleaned = priceStr
    .replace(/₺/g, '')
    .replace(/\s/g, '')
    .replace(/\./g, '')
    .replace(/,/g, '.');
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
};

// Validate price is within reasonable bounds
const isValidPrice = (price: number): boolean => {
  return price >= MIN_VALID_PRICE && price <= MAX_VALID_PRICE;
};

// Normalize fuel type to standard Turkish values
const normalizeFuel = (fuel: string): string => {
  if (!fuel) return 'Diger';
  const f = fuel.toLowerCase().trim();

  // Plug-in Hybrid variants (check first - most specific)
  if (f.includes('plug-in') || f.includes('phev')) {
    return 'Plug-in Hybrid';
  }

  // LPG/CNG (check before benzin - "benzin-lpg" should be LPG)
  if (f.includes('lpg')) return 'LPG';
  if (f.includes('cng')) return 'CNG';

  // Mild Hybrid variants (check before regular hybrid)
  if (f.includes('mild')) {
    return 'Mild Hybrid';
  }

  // Regular Hybrid variants (including "benzin-elektrik" from Renault)
  // Note: "elektrik - benzin" (with spaces) from Fiat is Mild Hybrid, handled above
  if (f.includes('hibrit') || f.includes('hybrid') || f.includes('hev') || f === 'benzin-elektrik') {
    return 'Hybrid';
  }

  // Mild Hybrid - "elektrik - benzin" or "elektrik-benzin" patterns (Fiat style)
  if ((f.includes('elektrik') && f.includes('benzin')) || (f.includes('benzin') && f.includes('elektrik'))) {
    return 'Mild Hybrid';
  }

  // Pure Electric
  if (f.includes('elektrik') || f.includes('electric') || f === 'ev' || f === 'bev') {
    return 'Elektrik';
  }

  // Diesel
  if (f.includes('dizel') || f.includes('diesel')) {
    return 'Dizel';
  }

  // Petrol/Benzin (check last - most generic)
  if (f.includes('benzin') || f.includes('petrol')) {
    return 'Benzin';
  }

  // Return original if no match (will be logged for investigation)
  return fuel;
};

// Filter and warn about invalid prices, normalize fuel types
const filterValidRows = (rows: PriceListRow[], brandName: string): PriceListRow[] => {
  const validRows: PriceListRow[] = [];
  const invalidPrices: { model: string; trim: string; price: number }[] = [];

  for (const row of rows) {
    if (isValidPrice(row.priceNumeric)) {
      // Normalize fuel type for consistency across all brands
      validRows.push({
        ...row,
        fuel: normalizeFuel(row.fuel),
      });
    } else if (row.priceNumeric > 0) {
      invalidPrices.push({
        model: row.model,
        trim: row.trim,
        price: row.priceNumeric,
      });
    }
  }

  if (invalidPrices.length > 0) {
    console.log(`  Warning: ${invalidPrices.length} rows with invalid prices filtered out for ${brandName}`);
    invalidPrices.slice(0, 3).forEach(item => {
      console.log(`    - ${item.model} ${item.trim}: ${item.price} TL`);
    });
    if (invalidPrices.length > 3) {
      console.log(`    ... and ${invalidPrices.length - 3} more`);
    }
  }

  return validRows;
};

// Volkswagen parser - extracts all available data including taxes, optional equipment, origin
const parseVWData = (data: any, brand: string): PriceListRow[] => {
  const rows: PriceListRow[] = [];
  try {
    const araclar = data?.Data?.FiyatBilgisi?.Arac;
    if (!Array.isArray(araclar)) return rows;

    araclar.forEach((arac: any) => {
      const priceData = arac?.AracXML?.PriceData;
      if (!priceData) return;

      const modelName = priceData['-ModelName'] || 'Unknown';

      // Extract model year from DateInfo: "2025 Model..."
      const dateInfo = priceData.DateInfo || arac.DateInfo || '';
      const modelYearMatch = dateInfo.match(/(\d{4})\s*Model/i);
      const modelYear = modelYearMatch ? modelYearMatch[1] : undefined;

      // Extract origin from Notes: "Menşei: Güney Afrika"
      let origin: string | undefined;
      const notes = priceData?.Notes?.Item;
      if (Array.isArray(notes)) {
        const originNote = notes.find((n: string) => typeof n === 'string' && n.includes('Menşei:'));
        if (originNote) {
          const originMatch = originNote.match(/Menşei:\s*(.+)/);
          if (originMatch) origin = originMatch[1].trim();
        }
      }

      // Extract optional equipment prices
      const optionalEquipment: { name: string; price: number }[] = [];
      const options = priceData?.Options?.Item;
      if (options) {
        const optSubItems = Array.isArray(options.SubItem)
          ? options.SubItem
          : options.SubItem ? [options.SubItem] : [];
        optSubItems.forEach((opt: any) => {
          if (opt && opt['-Title'] && opt['-Price2']) {
            optionalEquipment.push({
              name: opt['-Title'],
              price: parseInt(opt['-Price2'], 10) || 0,
            });
          }
        });
      }

      const subListItem = priceData?.SubList?.Item;
      if (!subListItem) return;

      const itemArray = Array.isArray(subListItem) ? subListItem : [subListItem];

      itemArray.forEach((item: any) => {
        const subItemArray = item.SubItem;
        if (!Array.isArray(subItemArray)) return;

        let donanim = '', motor = '', sanziman = '';
        let fiyat = '', listeFiyat = '', kampanyaFiyat = '', netFiyat = '';
        let otvTutar = '', kdvTutar = '', mtvTutar = '';
        let trafikTescil = '', noterHarci = '';
        let otvRate: number | undefined;

        subItemArray.forEach((detail: any) => {
          const title = detail['-Title'] || '';
          const value = detail['-Value'] || '';

          if (title === 'Donanım') donanim = value;
          else if (title === 'Motor') motor = value;
          else if (title === 'Şanzıman') sanziman = value;
          else if (title === 'Net Fiyat') netFiyat = value;
          else if (title.startsWith('ÖTV')) {
            otvTutar = value;
            // Extract OTV rate from title: "ÖTV (%75) (%80) (*5)" → 80
            const rateMatches = title.match(/\(%(\d+)\)/g);
            if (rateMatches && rateMatches.length > 0) {
              // Take the last rate (usually the active one)
              const lastRate = rateMatches[rateMatches.length - 1];
              const numMatch = lastRate.match(/(\d+)/);
              if (numMatch) otvRate = parseInt(numMatch[1], 10);
            }
          }
          else if (title.startsWith('KDV')) kdvTutar = value;
          else if (title.includes('Motorlu Taşıtlar Vergisi')) mtvTutar = value;
          else if (title.includes('Trafik') && title.includes('Tescil') && !title.includes('Hizmet')) {
            trafikTescil = value;
          }
          else if (title.includes('Noter') && !title.includes('Dahil')) {
            noterHarci = value;
          }
          else if (title.includes('Fiyat')) {
            // Capture different price types
            if (title.includes('Liste') && !title.includes('Noter')) {
              listeFiyat = value;
            } else if (title.includes('Kampanya') && !title.includes('Noter')) {
              kampanyaFiyat = value;
            } else if (!title.includes('Noter') && !title.includes('Net') && !title.includes('Dahil')) {
              // Main price (Anahtar Teslim or first Fiyat field)
              if (!fiyat) fiyat = value;
            }
          }
        });

        // Detect fuel type
        const combinedText = `${modelName} ${motor} ${donanim}`.toLowerCase();
        let yakit = '';
        if (combinedText.includes('e-hybrid') || combinedText.includes('ehybrid') || combinedText.includes('phev')) {
          yakit = 'Plug-in Hybrid';
        } else if (combinedText.includes('id.')) {
          yakit = 'Elektrik';
        } else if (combinedText.includes('tsi') || combinedText.includes('tfsi')) {
          yakit = 'Benzin';
        } else if (combinedText.includes('tdi')) {
          yakit = 'Dizel';
        } else if (combinedText.includes('tgi')) {
          yakit = 'CNG';
        }

        if (fiyat) {
          const priceListNumeric = listeFiyat ? parsePrice(listeFiyat) : undefined;
          const priceCampaignNumeric = kampanyaFiyat ? parsePrice(kampanyaFiyat) : undefined;

          rows.push({
            model: modelName,
            trim: donanim,
            engine: motor,
            transmission: sanziman,
            fuel: yakit,
            priceRaw: fiyat,
            priceNumeric: parsePrice(fiyat),
            brand,
            // Existing optional fields
            ...(priceListNumeric && isValidPrice(priceListNumeric) && { priceListNumeric }),
            ...(priceCampaignNumeric && isValidPrice(priceCampaignNumeric) && { priceCampaignNumeric }),
            // VW-specific new fields
            ...(modelYear && { modelYear }),
            ...(otvRate && { otvRate }),
            ...(netFiyat && { netPrice: parsePrice(netFiyat) }),
            ...(otvTutar && { otvAmount: parsePrice(otvTutar) }),
            ...(kdvTutar && { kdvAmount: parsePrice(kdvTutar) }),
            ...(mtvTutar && { mtvAmount: parsePrice(mtvTutar) }),
            ...(trafikTescil && { trafficRegistrationFee: parsePrice(trafikTescil) }),
            ...(noterHarci && { notaryFee: parsePrice(noterHarci) }),
            ...(origin && { origin }),
            ...(optionalEquipment.length > 0 && { optionalEquipment }),
          });
        }
      });
    });
  } catch (error) {
    console.error('VW parse error:', error);
    ErrorLogger.logError({
      category: 'PARSE_ERROR',
      source: 'collection',
      brand: 'Volkswagen',
      brandId: 'volkswagen',
      code: 'VW_PARSE_FAILED',
      message: `VW parse error: ${error instanceof Error ? error.message : String(error)}`,
      details: { error: String(error) },
    });
  }
  return rows;
};

// Skoda parser
const parseSkodaData = (data: any, brand: string): PriceListRow[] => {
  const rows: PriceListRow[] = [];
  try {
    // Get tabs for model year info
    const tabs = data?.pageProps?.tabs;
    let modelYear: string | undefined;
    if (Array.isArray(tabs) && tabs[0]?.title) {
      // Extract year from "2025 Model Yılı"
      const yearMatch = tabs[0].title.match(/(\d{4})/);
      if (yearMatch) modelYear = yearMatch[1];
    }

    // Get sections - try multiple structures
    let sections = data?.pageProps?.priceListSections;
    if (!sections && tabs?.[0]?.content?.priceListData?.priceListSections) {
      sections = tabs[0].content.priceListData.priceListSections;
    }
    // Try new initialData structure: initialData2025, initialData2026, etc.
    if (!sections) {
      const pageProps = data?.pageProps;
      if (pageProps) {
        for (const key of Object.keys(pageProps)) {
          if (key.startsWith('initialData')) {
            sections = pageProps[key]?.priceListData?.priceListSections;
            if (!modelYear) {
              const keyYear = key.match(/(\d{4})/);
              if (keyYear) modelYear = keyYear[1];
            }
            if (sections) break;
          }
        }
      }
    }
    if (!Array.isArray(sections)) return rows;

    sections.forEach((section: any) => {
      const items = section.items;
      if (!Array.isArray(items)) return;

      items.forEach((item: any) => {
        const modelName = item.title || 'Unknown';

        // Extract origin from description: "Menşei: Çekya"
        let origin: string | undefined;
        const description = item.priceListDetailDescription?.children;
        if (description) {
          const originMatch = description.match(/Menşei:\s*([^<\s5-9]+)/);
          if (originMatch) origin = originMatch[1].replace(/&nbsp;/g, '').trim();
        }

        // Extract optional equipment prices
        const optionalEquipment: { name: string; price: number }[] = [];
        const optTable = item.optionalEquipmentPricesTable?.data;
        if (Array.isArray(optTable)) {
          optTable.forEach((opt: any) => {
            const name = opt.optionalEquipment?.value;
            const priceStr = opt.modelPrice?.value;
            if (name && priceStr) {
              optionalEquipment.push({
                name: name.replace(/\d+-\d+$/, '').trim(), // Remove "3-5" suffix
                price: parsePrice(priceStr),
              });
            }
          });
        }

        const tableData = item.modelPricesTable?.data;
        if (!Array.isArray(tableData)) return;

        tableData.forEach((row: any) => {
          const donanim = row.hardware?.value || '';
          const fiyat = row.currentPrice?.value || '';
          const kampanyaFiyat = row.discountPrice?.value || '';
          const childData = row.currentPrice?.child;

          // Extract tax details from child array
          let netPrice: number | undefined;
          let otvAmount: number | undefined;
          let otvRate: number | undefined;
          let kdvAmount: number | undefined;
          let mtvAmount: number | undefined;
          let trafficRegistrationFee: number | undefined;

          if (Array.isArray(childData)) {
            childData.forEach((childItem: any[]) => {
              if (!Array.isArray(childItem) || childItem.length < 3) return;
              const label = childItem[0] || '';
              const value = childItem[2] || '';

              if (label.includes('Net Fiyat')) {
                netPrice = parsePrice(value);
              } else if (label.includes('ÖTV Tutarı')) {
                otvAmount = parsePrice(value);
                // Extract rate: "ÖTV Tutarı (%75)" → 75
                const rateMatch = label.match(/\(%(\d+)\)/);
                if (rateMatch) otvRate = parseInt(rateMatch[1], 10);
              } else if (label.includes('KDV Tutarı')) {
                kdvAmount = parsePrice(value);
              } else if (label.includes('MTV')) {
                mtvAmount = parsePrice(value);
              } else if (label.includes('Trafik') && label.includes('Tescil')) {
                trafficRegistrationFee = parsePrice(value);
              }
            });
          }

          // Determine transmission
          let sanziman = '';
          if (donanim.includes('DSG')) sanziman = 'DSG';
          else if (donanim.includes('Manuel')) sanziman = 'Manuel';
          else if (donanim.includes('Otomatik')) sanziman = 'Otomatik';

          // Determine fuel type
          const combinedText = `${modelName} ${donanim}`.toLowerCase();
          let yakit = '';
          if (combinedText.includes('elroq') || combinedText.includes('enyaq') || /\d+\s*e-/.test(combinedText)) {
            yakit = 'Elektrik';
          } else if (combinedText.includes('plug-in') || combinedText.includes('phev') || combinedText.includes('ivrs')) {
            yakit = 'Plug-in Hybrid';
          } else if (combinedText.includes('tsi') || combinedText.includes('tgi')) {
            yakit = 'Benzin';
          } else if (combinedText.includes('tdi')) {
            yakit = 'Dizel';
          }

          const motor = donanim.replace(/DSG|Manuel|Otomatik/gi, '').trim();

          if (fiyat) {
            const priceNumeric = parsePrice(fiyat);
            const priceCampaignNumeric = kampanyaFiyat ? parsePrice(kampanyaFiyat) : undefined;

            rows.push({
              model: modelName,
              trim: donanim,
              engine: motor,
              transmission: sanziman,
              fuel: yakit,
              priceRaw: fiyat,
              priceNumeric,
              brand,
              // Extended fields
              ...(modelYear && { modelYear }),
              ...(priceCampaignNumeric && isValidPrice(priceCampaignNumeric) && {
                priceListNumeric: priceNumeric, // Liste fiyatı = currentPrice
                priceCampaignNumeric,           // Kampanya fiyatı = discountPrice
              }),
              // Tax details (VW-compatible)
              ...(otvRate && { otvRate }),
              ...(netPrice && { netPrice }),
              ...(otvAmount && { otvAmount }),
              ...(kdvAmount && { kdvAmount }),
              ...(mtvAmount && { mtvAmount }),
              ...(trafficRegistrationFee && { trafficRegistrationFee }),
              // Origin & optional equipment
              ...(origin && { origin }),
              ...(optionalEquipment.length > 0 && { optionalEquipment }),
            });
          }
        });
      });
    });
  } catch (error) {
    console.error('Skoda parse error:', error);
    ErrorLogger.logError({
      category: 'PARSE_ERROR',
      source: 'collection',
      brand: 'Škoda',
      brandId: 'skoda',
      code: 'SKODA_PARSE_FAILED',
      message: `Skoda parse error: ${error instanceof Error ? error.message : String(error)}`,
      details: { error: String(error) },
    });
  }
  return rows;
};

// Renault/Dacia engine details parser - extracts detailed info from VersiyonAdi
interface RenaultEngineDetails {
  powerHP?: number;           // 90, 100, 115
  engineType?: string;        // "TCe", "dCi", "SCe", "E-TECH"
  isHybrid?: boolean;
  isElectric?: boolean;
}

function parseRenaultEngineDetails(versiyonAdi: string, yakitTipi: string): RenaultEngineDetails {
  const details: RenaultEngineDetails = {};
  const fuelLower = yakitTipi.toLowerCase();

  // Power HP - look for numbers like "100", "90", "115", "120hp", "150hp"
  // Pattern 1: number followed by hp/HP/ps/PS/bg (e.g., "120hp", "150HP")
  // Pattern 2: number at end or before specific keywords (e.g., "TCe 100", "90 eco-g")
  const hpSuffixMatch = versiyonAdi.match(/(\d{2,3})\s*(?:hp|ps|bg)\b/i);
  if (hpSuffixMatch) {
    details.powerHP = parseInt(hpSuffixMatch[1], 10);
  } else {
    const hpMatch = versiyonAdi.match(/\b(\d{2,3})\b(?:\s|$|eco|cvt|edc)/i);
    if (hpMatch) {
      details.powerHP = parseInt(hpMatch[1], 10);
    }
  }

  // Engine type - TCe, dCi, SCe, E-TECH, EV (for electric)
  if (/\bTCe\b/i.test(versiyonAdi)) {
    details.engineType = 'TCe';
  } else if (/\bdCi\b/i.test(versiyonAdi)) {
    details.engineType = 'dCi';
  } else if (/\bSCe\b/i.test(versiyonAdi)) {
    details.engineType = 'SCe';
  } else if (/E-TECH/i.test(versiyonAdi) || /E-TECH/i.test(yakitTipi)) {
    details.engineType = 'E-TECH';
  } else if (/\bEV\d+\b/i.test(versiyonAdi)) {
    details.engineType = 'EV';
  }

  // Hybrid detection (includes mild hybrid)
  if (fuelLower.includes('hybrid') || fuelLower.includes('hibrit') ||
    /E-TECH/i.test(versiyonAdi) || /E-TECH/i.test(yakitTipi) ||
    /mild\s*hybrid/i.test(versiyonAdi)) {
    details.isHybrid = true;
  }

  // Electric detection
  if (fuelLower.includes('elektrik') || fuelLower.includes('electric')) {
    details.isElectric = true;
  }

  return details;
}

// Renault parser
const parseRenaultData = (data: any, brand: string): PriceListRow[] => {
  const rows: PriceListRow[] = [];
  try {
    const results = data?.results;
    if (!Array.isArray(results)) return rows;

    results.forEach((item: any) => {
      const modelName = item.ModelAdi || 'Unknown';
      const trim = item.EkipmanAdi || item.VersiyonAdi || '';
      const engine = item.VersiyonAdi || '';
      const transmission = item.VitesTipi || '';
      const fuel = item.YakitTipi || '';
      const modelYear = item.ModelYili || '';

      // New fields from API
      const vehicleCategory = item.TicariBinek || undefined;  // "Binek", "Ticari"
      const hurdaFiyati = parseFloat(item.HurdaFiyati) || 0;

      // Get engine details using helper
      const engineDetails = parseRenaultEngineDetails(engine, fuel);

      // Prices
      const antesFiyati = parseFloat(item.AntesFiyati) || 0;
      const perFiyati = parseFloat(item.PerFiyati) || 0;
      const otvOran = parseInt(item.OtvOran, 10) || 0;

      // Calculate tax amounts from net price and ÖTV rate
      const otvAmount = perFiyati > 0 && otvOran > 0 ? perFiyati * (otvOran / 100) : 0;
      const kdvAmount = perFiyati > 0 && otvOran > 0 ? (perFiyati + otvAmount) * 0.20 : 0;

      // Format price string
      const priceRaw = antesFiyati
        ? `₺${antesFiyati.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : '';

      // Extract optional equipment
      const optionalEquipment: { name: string; price: number }[] = [];
      const opsiyonlar = item.OtoOpsiyonFiyatList?.OtoOpsiyonFiyat;
      if (Array.isArray(opsiyonlar)) {
        opsiyonlar.forEach((opt: any) => {
          if (opt.OpsiyonAdi && opt.OpsiyonFiyat) {
            optionalEquipment.push({
              name: opt.OpsiyonAdi,
              price: parseInt(opt.OpsiyonFiyat, 10) || 0,
            });
          }
        });
      }

      if (priceRaw && antesFiyati > 0) {
        rows.push({
          model: modelName,
          trim,
          engine,
          transmission,
          fuel,
          priceRaw,
          priceNumeric: antesFiyati,
          brand,
          // Extended fields
          ...(modelYear && { modelYear }),
          ...(otvOran > 0 && { otvRate: otvOran }),
          ...(perFiyati > 0 && { netPrice: perFiyati }),
          ...(otvAmount > 0 && { otvAmount: Math.round(otvAmount * 100) / 100 }),
          ...(kdvAmount > 0 && { kdvAmount: Math.round(kdvAmount * 100) / 100 }),
          // Optional equipment
          ...(optionalEquipment.length > 0 && { optionalEquipment }),
          // New fields from API
          ...(vehicleCategory && { vehicleCategory }),
          ...(hurdaFiyati > 0 && { otvIncentivePrice: hurdaFiyati }),
          // Engine details from helper
          ...(engineDetails.powerHP && { powerHP: engineDetails.powerHP }),
          ...(engineDetails.engineType && { engineType: engineDetails.engineType }),
          ...(engineDetails.isHybrid && { isHybrid: engineDetails.isHybrid }),
          ...(engineDetails.isElectric && { isElectric: engineDetails.isElectric }),
        });
      }
    });
  } catch (error) {
    console.error('Renault parse error:', error);
  }
  return rows;
};

// Toyota parser
const parseToyotaData = (data: any, brand: string): PriceListRow[] => {
  const rows: PriceListRow[] = [];
  try {
    let models = data?.Data?.Model;
    if (!models) return rows;
    if (!Array.isArray(models)) models = [models];

    models.forEach((model: any) => {
      let modelFiyatArray = model.ModelFiyat;
      if (!modelFiyatArray) return;
      if (!Array.isArray(modelFiyatArray)) modelFiyatArray = [modelFiyatArray];

      // Extract origin from parent Model's Aciklama field (shared across all variants)
      let modelOrigin: string | undefined;
      const modelAciklama = model.Aciklama || '';
      const originMatch = modelAciklama.match(/Menşei\s*:\s*([^<\n\*]+)/i);
      if (originMatch) {
        modelOrigin = originMatch[1].trim();
      }

      modelFiyatArray.forEach((item: any) => {
        if (item.Durum !== 1 && item.Durum !== '1') return;

        const modelName = item.Model || 'Unknown';
        if (modelName.includes('%') || modelName.includes('ÖTV') || modelName.toLowerCase().includes('tüm versiyonlarda')) return;

        const govde = item.Govde || '';
        const motorHacmi = item.MotorHacmi != null ? String(item.MotorHacmi) : '';
        const vitesTipi = item.VitesTipi || '';
        const motorTipi = item.MotorTipi || '';
        const modelYili = item.ModelYili || '';
        const origin = modelOrigin; // Use parent Model's origin

        // Extract all price fields
        const kampanyali1 = item.KampanyaliFiyati1 ? item.KampanyaliFiyati1.toString().replace(/\s*TL\s*$/i, '').trim() : '';
        const kampanyali2 = item.KampanyaliFiyati2 ? item.KampanyaliFiyati2.toString().replace(/\s*TL\s*$/i, '').trim() : '';
        const liste1 = item.ListeFiyati1 ? item.ListeFiyati1.toString().replace(/\s*TL\s*$/i, '').trim() : '';
        const liste2 = item.ListeFiyati2 ? item.ListeFiyati2.toString().replace(/\s*TL\s*$/i, '').trim() : '';
        const otvTesvikli = item.OTVTesvikli1 ? item.OTVTesvikli1.toString().replace(/\s*TL\s*$/i, '').trim() : '';

        // Primary price: prefer campaign, fallback to list, then OTV incentive
        let fiyat = kampanyali2 || kampanyali1 || liste2 || liste1 || otvTesvikli || '';

        // List price (original price before campaign)
        const listeFiyat = liste1 || liste2 || '';
        const priceListNumeric = listeFiyat ? parsePrice(listeFiyat) : undefined;

        // Campaign price
        const kampanyaFiyat = kampanyali1 || kampanyali2 || '';
        const priceCampaignNumeric = kampanyaFiyat ? parsePrice(kampanyaFiyat) : undefined;

        // OTV Incentive price (for hybrids - hurda teşvikli fiyat)
        const otvIncentivePrice = otvTesvikli ? parsePrice(otvTesvikli) : undefined;

        let yakit = '';
        const motorTipiLower = motorTipi.toLowerCase();
        if (motorTipiLower.includes('hybrid') || motorTipiLower.includes('hibrit')) yakit = 'Hybrid';
        else if (motorTipiLower.includes('benzin')) yakit = 'Benzin';
        else if (motorTipiLower.includes('dizel')) yakit = 'Dizel';
        else if (motorTipiLower.includes('elektrik')) yakit = 'Elektrik';

        if (fiyat) {
          rows.push({
            model: govde,
            trim: modelName,
            engine: motorHacmi,
            transmission: vitesTipi,
            fuel: yakit,
            priceRaw: fiyat,
            priceNumeric: parsePrice(fiyat),
            brand,
            // Extended fields
            ...(modelYili && { modelYear: modelYili }),
            ...(origin && { origin }),
            ...(priceListNumeric && isValidPrice(priceListNumeric) && { priceListNumeric }),
            ...(priceCampaignNumeric && isValidPrice(priceCampaignNumeric) && { priceCampaignNumeric }),
            // Toyota-specific: OTV incentive price (hurda teşvikli)
            ...(otvIncentivePrice && isValidPrice(otvIncentivePrice) && { otvIncentivePrice }),
          });
        }
      });
    });
  } catch (error) {
    console.error('Toyota parse error:', error);
  }
  return rows;
};

// Hyundai parser
const parseHyundaiData = (data: any, brand: string): PriceListRow[] => {
  const rows: PriceListRow[] = [];
  try {
    const productList = data?.productList;
    if (!Array.isArray(productList)) return rows;

    productList.forEach((product: any) => {
      const productName = product.productName || 'Unknown';
      const yearDetailList = product.yearDetailList;
      if (!Array.isArray(yearDetailList)) return;

      // Extract origin from productName (e.g., "i20 - Yerli Üretim" -> "Türkiye")
      let origin: string | undefined;
      if (productName.toLowerCase().includes('yerli üretim')) {
        origin = 'Türkiye';
      }

      // Clean model name (remove " - Yerli Üretim" suffix for cleaner display)
      const cleanModelName = productName.replace(/\s*-\s*Yerli Üretim/i, '').trim();

      yearDetailList.forEach((yearDetail: any) => {
        const priceDetailList = yearDetail.priceDetailList;
        if (!Array.isArray(priceDetailList)) return;

        // Extract model year from yearDetail
        const modelYear = yearDetail.year || yearDetail.modelYear || undefined;

        priceDetailList.forEach((item: any) => {
          const trimName = item.trimName || '';
          const powertrainName = item.powertrainName || '';
          const transmission = item.transmission || '';
          const fuelName = item.fuelName || '';

          // Extract both list and campaign prices
          const listPrice = item.listPrice || item.basePrice || '';
          const campaignPrice = item.suggestedPrice || item.campaignPrice || '';
          const price = campaignPrice || listPrice || item.price || '';

          if (price && price !== 'N/A') {
            const priceNumeric = parsePrice(price.toString());
            const priceListNumeric = listPrice ? parsePrice(listPrice.toString()) : undefined;
            const priceCampaignNumeric = campaignPrice ? parsePrice(campaignPrice.toString()) : undefined;

            rows.push({
              model: cleanModelName,
              trim: trimName,
              engine: powertrainName.replace(trimName, '').trim(),
              transmission,
              fuel: fuelName,
              priceRaw: price.toString(),
              priceNumeric,
              brand,
              // Extended fields
              ...(modelYear && { modelYear }),
              ...(origin && { origin }),
              ...(priceListNumeric && isValidPrice(priceListNumeric) && { priceListNumeric }),
              ...(priceCampaignNumeric && isValidPrice(priceCampaignNumeric) && { priceCampaignNumeric }),
            });
          }
        });
      });
    });
  } catch (error) {
    console.error('Hyundai parse error:', error);
  }
  return rows;
};

// Fiat PDF parser helper functions
interface PDFItem {
  x: number;
  y: number;
  str: string;
  width: number;
  height: number;
}

// Group PDF items by Y position (with tolerance) to reconstruct table rows
function groupByRows(items: PDFItem[], tolerance = 8): PDFItem[][] {
  const rows: PDFItem[][] = [];
  let currentRow: PDFItem[] = [];
  let currentY: number | null = null;

  // Sort by Y first
  const sorted = [...items].sort((a, b) => a.y - b.y);

  for (const item of sorted) {
    if (currentY === null || Math.abs(item.y - currentY) <= tolerance) {
      currentRow.push(item);
      if (currentY === null) currentY = item.y;
    } else {
      if (currentRow.length > 0) {
        rows.push(currentRow.sort((a, b) => a.x - b.x));
      }
      currentRow = [item];
      currentY = item.y;
    }
  }

  if (currentRow.length > 0) {
    rows.push(currentRow.sort((a, b) => a.x - b.x));
  }

  return rows;
}

// Extract text from PDF row
function rowToText(row: PDFItem[]): string {
  return row.map(item => item.str.trim()).filter(Boolean).join(' ');
}

// Fiat engine details parser - extracts detailed info from engine strings
interface FiatEngineDetails {
  engineDisplacement?: string;   // "1.6L", "1.4L", "1.2L"
  engineType?: string;           // "M.Jet", "Fire", "MHEV"
  powerHP?: number;              // 95, 118, 130
  powerKW?: number;              // 6, 87
  batteryCapacity?: number;      // 5.5, 42, 44, 54
  hasGSR?: boolean;              // true/false
  hasTractionPlus?: boolean;     // true/false
  isElectric?: boolean;          // true/false
  isHybrid?: boolean;            // true/false
}

function parseFiatEngineDetails(engine: string): FiatEngineDetails {
  const details: FiatEngineDetails = {};

  // Battery capacity (kWh)
  const batteryMatch = engine.match(/(\d+\.?\d*)\s*kWh/i);
  if (batteryMatch) {
    details.batteryCapacity = parseFloat(batteryMatch[1]);
    details.isElectric = true;
  }

  // Power kW (electric vehicles) - but not kWh
  const kwMatch = engine.match(/(\d+)\s*kW(?!h)/i);
  if (kwMatch) {
    details.powerKW = parseInt(kwMatch[1], 10);
  }

  // Power HP (all types)
  const hpMatch = engine.match(/(\d+)\s*(?:HP|BG|hp)/i);
  if (hpMatch) {
    details.powerHP = parseInt(hpMatch[1], 10);
  }

  // Engine displacement (diesel/petrol)
  const displacementMatch = engine.match(/^(\d+\.\d+)\s*/);
  if (displacementMatch) {
    details.engineDisplacement = displacementMatch[1] + 'L';
  }

  // Engine type
  if (/M\.?Jet/i.test(engine)) {
    details.engineType = 'M.Jet';
  } else if (/Fire/i.test(engine)) {
    details.engineType = 'Fire';
  } else if (/MHEV/i.test(engine)) {
    details.engineType = 'MHEV';
    details.isHybrid = true;
  }

  // Fiat-specific features
  details.hasGSR = /GSR/i.test(engine);
  details.hasTractionPlus = /Traction\+?/i.test(engine);

  return details;
}

// Get Fiat origin based on model
function getFiatOrigin(model: string): string | undefined {
  // Egea family is manufactured in Turkey (Bursa/Tofas)
  if (/^Egea/i.test(model)) {
    return 'Türkiye';
  }
  // Other models are imported (mostly from Italy)
  // Return undefined since we don't have confirmed info
  return undefined;
}

// Fiat parser - parses PDF data
const parseFiatData = (pdfData: PDFExtractResult, brand: string): PriceListRow[] => {
  const vehicles: PriceListRow[] = [];

  const trims = [
    'Street', 'Urban', 'Lounge', 'Limited', 'Easy', 'Pop', 'Sport', 'Red', 'Star',
    'Topolino Plus', 'Topolino', 'Dolcevita', 'La Prima', 'Icon', 'Action', 'Passion', 'Connect',
    '(RED)', 'Cross', 'City Cross', 'Hybrid', 'e-Hybrid',
    // 500e specific trims
    '3+1', 'Cabrio', 'Giorgio Armani'
  ];
  const transmissions = ['Manuel', 'Otomatik', 'DCT', 'e-DCT', 'eDCT', 'CVT'];
  const fuels = ['Benzin', 'Benzinli', 'Dizel', 'Elektrik', 'Elektrikli', 'Hybrid', 'Hibrit', 'BEV', 'Elektrikli - Benzinli'];

  const enginePatterns = [
    // Diesel engines - capture only engine specs, not trailing text
    /(\d+\.\d+\s*M\.?Jet\s*\d+\s*HP(?:\s*DCT)?(?:\s*GSR\*?)?)/i,
    // Petrol engines
    /(\d+\.\d+\s*Fire\s*\d+\s*HP(?:\s*GSR\*?)?)/i,
    // Electric engines (various formats) - with kW and kWh
    /(\d+\s*kW\s*\/?\s*\d+\s*HP\s*[-–]\s*\d+\.?\d*\s*kWh)/i,
    /(\d+\s*kWh)/i,
    // MHEV hybrid
    /(\d+\.\d+\s*MHEV?\s*\d+\s*HP(?:\s*e?DCT)?)/i,
    /(\d+\.\d+\s*\d+\s*hp\s*MHEV)/i,
    // Hybrid engines
    /(\d+\.\d+\s*(?:e-?)?Hybrid\s*\d+\s*HP)/i,
  ];

  // The Fiat price-list PDF is sometimes published as an image-only/scanned file
  // with no embedded text layer. Text extractors (pdf.js-extract, pdf-parse) then
  // return nothing, so detect it explicitly and surface a specific error instead of
  // a silent empty parse that just falls back to stale data with no explanation.
  const totalItems = pdfData.pages.reduce((sum, p) => sum + (p.content?.length || 0), 0);
  if (totalItems === 0) {
    ErrorLogger.logError({
      category: 'PARSE_ERROR',
      source: 'collection',
      brand,
      brandId: 'fiat',
      code: 'IMAGE_BASED_PDF',
      message: `${brand} PDF has no extractable text (image-based/scanned). OCR or an alternative data source is required.`,
      recovered: true,
      recoveryMethod: 'Falls back to previous data',
    });
    return vehicles; // empty -> caller falls back to previous data
  }

  try {
    for (const page of pdfData.pages) {
      const items = page.content as PDFItem[];
      const rows = groupByRows(items);

      let currentModel = '';
      let currentEngine = '';
      let inDataSection = false;

      for (const row of rows) {
        const text = rowToText(row);

        // Detect model headers
        if (/EGEA\s+SEDAN.*MODEL/i.test(text)) {
          currentModel = 'Egea Sedan';
          currentEngine = '';
          inDataSection = true;
          continue;
        }
        if (/EGEA\s+CROSS.*MODEL/i.test(text)) {
          currentModel = 'Egea Cross';
          currentEngine = '';
          inDataSection = true;
          continue;
        }
        if (/EGEA\s+HATCHBACK.*MODEL/i.test(text)) {
          currentModel = 'Egea Hatchback';
          currentEngine = '';
          inDataSection = true;
          continue;
        }
        if (/GRANDE\s+PANDA\s+(ELEKTRİKLİ|HYBRID).*MODEL/i.test(text)) {
          const variant = text.includes('ELEKTRİKLİ') ? 'Elektrikli' : 'Hybrid';
          currentModel = `Grande Panda ${variant}`;
          currentEngine = '';
          inDataSection = true;
          continue;
        }
        if (/GRANDE\s+PANDA.*MODEL/i.test(text) || /FIAT\s+GRANDE\s+PANDA.*MODEL/i.test(text)) {
          currentModel = 'Grande Panda';
          currentEngine = '';
          inDataSection = true;
          continue;
        }
        if (/600\s+(BEV|MHEV).*MODEL/i.test(text)) {
          const variant = text.includes('BEV') ? 'BEV' : 'MHEV';
          currentModel = `600 ${variant}`;
          currentEngine = '';
          inDataSection = true;
          continue;
        }
        if (/FIAT\s+600.*MODEL/i.test(text) || /^600\s+\d{4}\s*MODEL/i.test(text)) {
          currentModel = '600';
          currentEngine = '';
          inDataSection = true;
          continue;
        }
        if (/FIAT\s+500e.*MODEL/i.test(text) || /500e\s+\d{4}\s*MODEL/i.test(text)) {
          currentModel = '500e';
          currentEngine = '';
          inDataSection = true;
          continue;
        }
        if (/TOPOLINO\s+\d{4}\s*MODEL/i.test(text) || /TOPOLINO.*MODEL/i.test(text)) {
          // Extract year from text if present
          const yearMatch = text.match(/(\d{4})\s*MODEL/i);
          currentModel = yearMatch ? `Topolino ${yearMatch[1]}` : 'Topolino';
          currentEngine = '';
          inDataSection = true;
          continue;
        }
        if (/TIPO.*MODEL/i.test(text)) {
          currentModel = text.includes('CROSS') ? 'Tipo Cross' :
            text.includes('SW') ? 'Tipo SW' : 'Tipo';
          currentEngine = '';
          inDataSection = true;
          continue;
        }
        if (/500X.*MODEL/i.test(text)) {
          currentModel = '500X';
          currentEngine = '';
          inDataSection = true;
          continue;
        }
        if (/PANDA.*MODEL/i.test(text) && !/GRANDE/i.test(text)) {
          currentModel = 'Panda';
          currentEngine = '';
          inDataSection = true;
          continue;
        }

        // Skip header rows
        if (/Motor.*Donanım.*Şanzıman/i.test(text)) continue;
        if (/Tavsiye Edilen.*Liste Fiyatı/i.test(text)) continue;
        if (/OPSİYONLAR/i.test(text)) {
          inDataSection = false;
          continue;
        }

        if (!inDataSection || !currentModel) continue;

        // Detect engine specs
        for (const pattern of enginePatterns) {
          const match = text.match(pattern);
          if (match) {
            currentEngine = match[1].trim().replace(/\s+/g, ' ');
            break;
          }
        }

        // Look for data rows with trim + transmission + fuel + prices
        let foundTrim: string | null = null;
        let foundTrans: string | null = null;
        let foundFuel: string | null = null;
        let rowEngine: string | null = null;
        const prices: number[] = [];

        for (const item of row) {
          const txt = item.str.trim();

          // Check for trim
          for (const trim of trims) {
            if (txt.toLowerCase() === trim.toLowerCase()) {
              foundTrim = trim;
              break;
            }
          }

          // Check for transmission
          for (const trans of transmissions) {
            if (txt.toLowerCase().includes(trans.toLowerCase())) {
              foundTrans = trans === 'DCT' || trans === 'eDCT' || trans === 'e-DCT' ? 'Otomatik' : trans;
              break;
            }
          }

          // Check for fuel
          for (const fuel of fuels) {
            if (txt.toLowerCase() === fuel.toLowerCase() || txt.toLowerCase() === fuel.toLowerCase().replace(' - ', ' ')) {
              foundFuel = fuel
                .replace('Benzinli', 'Benzin')
                .replace('Elektrikli', 'Elektrik')
                .replace('Elektrikli - Benzinli', 'Hybrid');
              break;
            }
          }

          // Check for inline engine info (for electric models where engine is in same row)
          if (!rowEngine) {
            for (const pattern of enginePatterns) {
              const match = txt.match(pattern);
              if (match) {
                rowEngine = match[1].trim().replace(/\s+/g, ' ');
                break;
              }
            }
          }

          // Check for price (Turkish format: 1.234.567 TL or just 1.234.567)
          if (/^\d{1,3}(?:\.\d{3})+(?:\s*TL)?$/.test(txt)) {
            const priceMatch = txt.match(/[\d.]+/g);
            if (priceMatch) {
              const cleaned = priceMatch.join('').replace(/\./g, '');
              const price = parseInt(cleaned, 10);
              if (price >= 400000 && price <= 10000000) {
                prices.push(price);
              }
            }
          }
        }

        // Use row engine if no current engine set, or prefer row engine for electric models
        const effectiveEngine = rowEngine || currentEngine;

        // If we found a complete vehicle record
        if (foundTrim && prices.length > 0 && effectiveEngine) {
          // First price is Liste Fiyatı, second (if exists) might be campaign price
          const priceListNumeric = prices[0];
          const priceCampaignNumeric = prices.length > 1 ? prices[1] : undefined;

          // Use campaign price if it's lower (valid campaign), otherwise list price
          const price = (priceCampaignNumeric && priceCampaignNumeric < priceListNumeric)
            ? priceCampaignNumeric
            : priceListNumeric;

          // Extract model year from model name (e.g., "Topolino 2026" -> 2026)
          let cleanModel = currentModel;
          let modelYear: number | undefined;
          const yearMatch = currentModel.match(/\s*(\d{4})$/);
          if (yearMatch) {
            modelYear = parseInt(yearMatch[1], 10);
            cleanModel = currentModel.replace(/\s*\d{4}$/, '').trim();
          }

          // Check for duplicate (using cleanModel)
          const exists = vehicles.find(
            v => v.model === cleanModel &&
              v.trim === foundTrim &&
              v.engine === effectiveEngine &&
              v.priceNumeric === price
          );

          if (!exists) {
            // Parse engine details for extended fields
            const engineDetails = parseFiatEngineDetails(effectiveEngine);

            // Get origin based on model
            const origin = getFiatOrigin(cleanModel);

            vehicles.push({
              model: cleanModel,
              trim: foundTrim,
              engine: effectiveEngine,
              transmission: foundTrans || '',
              fuel: foundFuel || '',
              priceRaw: price.toLocaleString('tr-TR') + ' TL',
              priceNumeric: price,
              brand,
              // Price fields
              ...(isValidPrice(priceListNumeric) && { priceListNumeric }),
              ...(priceCampaignNumeric && isValidPrice(priceCampaignNumeric) && { priceCampaignNumeric }),
              // New extended fields
              ...(modelYear && { modelYear }),
              ...(origin && { origin }),
              ...(engineDetails.batteryCapacity && { batteryCapacity: engineDetails.batteryCapacity }),
              ...(engineDetails.powerKW && { powerKW: engineDetails.powerKW }),
              ...(engineDetails.powerHP && { powerHP: engineDetails.powerHP }),
              ...(engineDetails.engineDisplacement && { engineDisplacement: engineDetails.engineDisplacement }),
              ...(engineDetails.engineType && { engineType: engineDetails.engineType }),
              ...(engineDetails.hasGSR && { hasGSR: engineDetails.hasGSR }),
              ...(engineDetails.hasTractionPlus && { hasTractionPlus: engineDetails.hasTractionPlus }),
              ...(engineDetails.isElectric && { isElectric: engineDetails.isElectric }),
              ...(engineDetails.isHybrid && { isHybrid: engineDetails.isHybrid }),
            });
          }
        }
      }
    }
  } catch (error) {
    console.error('Fiat PDF parse error:', error);
  }

  return vehicles;
};

// === Peugeot Helper Functions ===

interface PeugeotEngineDetails {
  powerKW?: number;           // 100, 115, 157
  powerHP?: number;           // 100, 120, 130, 140, 145, 150, 180
  engineDisplacement?: string; // "1.2L", "1.5L", "2.0L", "2.2L"
  engineType?: string;        // "PureTech", "BlueHDi", "Hybrid"
  transmissionType?: string;  // "EAT8", "eDCS6", "MT6"
  isElectric?: boolean;
  isHybrid?: boolean;
  emissionStandard?: string;  // "€6eBIS"
}

function parsePeugeotEngineDetails(engine: string, modelInfo: string): PeugeotEngineDetails {
  const details: PeugeotEngineDetails = {};
  const combined = `${engine} ${modelInfo}`;

  // Power kW (electric)
  const kwMatch = combined.match(/(\d+)\s*kW(?!h)/i);
  if (kwMatch) {
    details.powerKW = parseInt(kwMatch[1], 10);
    details.isElectric = true;
  }

  // Power HP (ICE/Hybrid)
  const hpMatch = combined.match(/(\d+)\s*hp/i);
  if (hpMatch) {
    details.powerHP = parseInt(hpMatch[1], 10);
  }

  // Engine displacement
  const dispMatch = combined.match(/(\d+\.\d+)\s*(?:PureTech|BlueHDi|Hybrid)/i);
  if (dispMatch) {
    details.engineDisplacement = dispMatch[1] + 'L';
  }

  // Engine type
  if (/PureTech/i.test(combined)) {
    details.engineType = 'PureTech';
  } else if (/BlueHDi/i.test(combined)) {
    details.engineType = 'BlueHDi';
  } else if (/Hybrid/i.test(combined)) {
    details.engineType = 'Hybrid';
    details.isHybrid = true;
  }

  // Transmission type
  if (/EAT8/i.test(combined)) {
    details.transmissionType = 'EAT8';
  } else if (/eDCS6/i.test(combined)) {
    details.transmissionType = 'eDCS6';
  } else if (/MT6|6MT/i.test(combined)) {
    details.transmissionType = 'MT6';
  }

  // Emission standard
  if (/€6eBIS|E6eBIS|Euro\s*6e\s*BIS/i.test(combined)) {
    details.emissionStandard = '€6eBIS';
  }

  return details;
}

interface PeugeotCommercialDetails {
  vehicleCategory?: string;   // "Binek", "Ticari"
  vehicleLength?: string;     // "L2", "L3", "L4H2", "L4H3"
  cargoVolume?: number;       // 15, 17 (m³)
  seatingCapacity?: string;   // "8+1", "16+1"
  hasPanoramicRoof?: boolean; // for 408
}

function parsePeugeotCommercialDetails(model: string, modelInfo: string): PeugeotCommercialDetails {
  const details: PeugeotCommercialDetails = {};
  const combined = `${model} ${modelInfo}`;

  // Vehicle category
  if (/Van|Traveller|Minibüs|Minibus|Rifter|Partner|Expert|Boxer/i.test(model)) {
    details.vehicleCategory = 'Ticari';
  } else {
    details.vehicleCategory = 'Binek';
  }

  // Vehicle length (Van sizes)
  const lengthMatch = combined.match(/\b(L2|L3|L4(?:H[23])?)\b/i);
  if (lengthMatch) {
    details.vehicleLength = lengthMatch[1].toUpperCase();
  }

  // Cargo volume
  const volumeMatch = combined.match(/(\d+)\s*m[³3]/i);
  if (volumeMatch) {
    details.cargoVolume = parseInt(volumeMatch[1], 10);
  }

  // Seating capacity
  const seatingMatch = combined.match(/(\d+\+1)/);
  if (seatingMatch) {
    details.seatingCapacity = seatingMatch[1];
  }

  // Panoramic roof (408 specific)
  if (/Cam Tavan|Panoramik/i.test(combined)) {
    details.hasPanoramicRoof = true;
  }

  return details;
}

// Peugeot parser - parses PDF data
const parsePeugeotData = (pdfData: PDFExtractResult, brand: string): PriceListRow[] => {
  const vehicles: PriceListRow[] = [];

  // Model patterns to detect headers
  const modelPatterns = [
    { regex: /PEUGEOT\s+E-208/i, model: 'E-208', fuel: 'Elektrik' },
    { regex: /PEUGEOT\s+E-308/i, model: 'E-308', fuel: 'Elektrik' },
    { regex: /PEUGEOT\s+E-2008/i, model: 'E-2008', fuel: 'Elektrik' },
    { regex: /PEUGEOT\s+E-3008/i, model: 'E-3008', fuel: 'Elektrik' },
    { regex: /PEUGEOT\s+E-5008/i, model: 'E-5008', fuel: 'Elektrik' },
    { regex: /PEUGEOT\s+2008(?!\s*E)/i, model: '2008', fuel: '' },
    { regex: /PEUGEOT\s+3008(?!\s*E)/i, model: '3008', fuel: '' },
    { regex: /PEUGEOT\s+5008(?!\s*E)/i, model: '5008', fuel: '' },
    { regex: /PEUGEOT\s+408/i, model: '408', fuel: '' },
    { regex: /PEUGEOT\s+508/i, model: '508', fuel: '' },
    { regex: /PEUGEOT\s+RIFTER/i, model: 'Rifter', fuel: 'Dizel' },
    { regex: /PEUGEOT\s+PARTNER\s+VAN/i, model: 'Partner Van', fuel: 'Dizel' },
    { regex: /PEUGEOT\s+EXPERT\s+VAN/i, model: 'Expert Van', fuel: 'Dizel' },
    { regex: /PEUGEOT\s+EXPERT\s+TRAVELLER/i, model: 'Expert Traveller', fuel: 'Dizel' },
    { regex: /PEUGEOT\s+BOXER\s+VAN/i, model: 'Boxer Van', fuel: 'Dizel' },
    { regex: /PEUGEOT\s+BOXER\s+Minibüs/i, model: 'Boxer Minibüs', fuel: 'Dizel' },
  ];

  const trims = ['GT', 'Allure', 'ALLURE', 'Active', 'ACTIVE', 'Comfort', 'COMFORT', 'Style', 'STYLE'];

  try {
    // Try to extract model year from PDF header (e.g., "Ocak 2026", "2026 Model Yılı")
    let pdfModelYear: number | undefined;
    if (pdfData.pages.length > 0) {
      const firstPageText = (pdfData.pages[0].content as PDFItem[]).map(i => i.str).join(' ');
      const yearMatch = firstPageText.match(/\b(202[4-9]|203\d)\b/);
      if (yearMatch) {
        pdfModelYear = parseInt(yearMatch[1], 10);
      }
    }

    for (const page of pdfData.pages) {
      const items = page.content as PDFItem[];
      const rows = groupByRows(items);

      let currentModel = '';
      let currentFuel = '';

      for (const row of rows) {
        const text = rowToText(row);

        // Detect model headers
        for (const mp of modelPatterns) {
          if (mp.regex.test(text)) {
            currentModel = mp.model;
            currentFuel = mp.fuel;
            break;
          }
        }

        if (!currentModel) continue;

        // Skip option/accessory rows and header rows
        if (/Metalik Boya|Opsiyonlar|MODELLER|Anahtar Teslim Fiyatı|Kampanyalı/i.test(text) && !/^\d/.test(text)) continue;
        if (/Elektrikli.*koltuk|Panoramik|Visiopark|Kamera|Klima|Jant/i.test(text)) continue;

        // Parse vehicle rows - format: "Model Trim Engine | Price1 TL | Price2 TL"
        // Example: "E-208 GT 100kW | 1.999.500 TL | 1.960.000 TL"
        // First price is usually list price, second is campaign price
        const priceMatches = text.match(/(\d{1,3}(?:\.\d{3})+)\s*TL/g);
        if (!priceMatches || priceMatches.length === 0) continue;

        // Extract first price (list price)
        const firstPriceMatch = priceMatches[0].match(/(\d{1,3}(?:\.\d{3})+)/);
        if (!firstPriceMatch) continue;
        const priceListNumeric = parseInt(firstPriceMatch[1].replace(/\./g, ''), 10);

        // Extract second price (campaign price) if exists
        let priceCampaignNumeric: number | undefined;
        if (priceMatches.length > 1) {
          const secondPriceMatch = priceMatches[1].match(/(\d{1,3}(?:\.\d{3})+)/);
          if (secondPriceMatch) {
            priceCampaignNumeric = parseInt(secondPriceMatch[1].replace(/\./g, ''), 10);
          }
        }

        // Use campaign price if valid and lower, otherwise list price
        const priceNumeric = (priceCampaignNumeric && priceCampaignNumeric < priceListNumeric && priceCampaignNumeric >= 500000)
          ? priceCampaignNumeric
          : priceListNumeric;

        // Skip if price is too low (likely an option price)
        if (priceNumeric < 500000) continue;

        // Extract model info from the beginning of the row
        const modelInfoMatch = text.match(/^([^|]+)/);
        if (!modelInfoMatch) continue;
        const modelInfo = modelInfoMatch[1].trim();

        // Parse trim and engine
        let trim = '';
        let engine = '';
        let fuel = currentFuel;

        // Detect trim
        for (const t of trims) {
          if (modelInfo.toUpperCase().includes(t.toUpperCase())) {
            trim = t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
            break;
          }
        }

        // Detect engine and fuel
        if (/(\d+)\s*kW/i.test(modelInfo)) {
          const kwMatch = modelInfo.match(/(\d+)\s*kW/i);
          engine = kwMatch ? `${kwMatch[1]} kW` : '';
          fuel = 'Elektrik';
        } else if (/PureTech\s*(\d+)\s*hp/i.test(modelInfo)) {
          const ptMatch = modelInfo.match(/(\d+\.\d+)\s*PureTech\s*(\d+)\s*hp/i);
          engine = ptMatch ? `${ptMatch[1]} PureTech ${ptMatch[2]} HP` : '';
          fuel = 'Benzin';
        } else if (/Hybrid\s*(\d+)\s*hp/i.test(modelInfo)) {
          const hybMatch = modelInfo.match(/(\d+\.\d+)\s*Hybrid\s*(\d+)\s*hp/i);
          engine = hybMatch ? `${hybMatch[1]} Hybrid ${hybMatch[2]} HP` : '';
          fuel = 'Hybrid';
        } else if (/BlueHDi\s*(\d+)\s*hp/i.test(modelInfo)) {
          const dMatch = modelInfo.match(/(\d+\.\d+)\s*BlueHDi\s*(\d+)\s*hp/i);
          engine = dMatch ? `${dMatch[1]} BlueHDi ${dMatch[2]} HP` : '';
          fuel = 'Dizel';
        }

        // Detect transmission
        let transmission = '';
        if (/EAT8|eDCS6|EAT6/i.test(modelInfo)) {
          transmission = 'Otomatik';
        } else if (/6MT|MT6/i.test(modelInfo)) {
          transmission = 'Manuel';
        }

        // Skip if no trim found (likely a header or option row)
        if (!trim) continue;

        // Check for duplicate
        const exists = vehicles.find(
          v => v.model === currentModel &&
            v.trim === trim &&
            v.engine === engine &&
            v.priceNumeric === priceNumeric
        );

        if (!exists) {
          // Parse engine and commercial details
          const engineDetails = parsePeugeotEngineDetails(engine, modelInfo);
          const commercialDetails = parsePeugeotCommercialDetails(currentModel, modelInfo);

          vehicles.push({
            model: currentModel,
            trim,
            engine,
            transmission,
            fuel,
            priceRaw: priceNumeric.toLocaleString('tr-TR') + ' TL',
            priceNumeric,
            brand,
            ...(pdfModelYear && { modelYear: pdfModelYear }),
            // Price fields
            ...(isValidPrice(priceListNumeric) && { priceListNumeric }),
            ...(priceCampaignNumeric && isValidPrice(priceCampaignNumeric) && { priceCampaignNumeric }),
            // Engine/Power fields
            ...(engineDetails.powerKW && { powerKW: engineDetails.powerKW }),
            ...(engineDetails.powerHP && { powerHP: engineDetails.powerHP }),
            ...(engineDetails.engineDisplacement && { engineDisplacement: engineDetails.engineDisplacement }),
            ...(engineDetails.engineType && { engineType: engineDetails.engineType }),
            ...(engineDetails.transmissionType && { transmissionType: engineDetails.transmissionType }),
            ...(engineDetails.isElectric && { isElectric: engineDetails.isElectric }),
            ...(engineDetails.isHybrid && { isHybrid: engineDetails.isHybrid }),
            ...(engineDetails.emissionStandard && { emissionStandard: engineDetails.emissionStandard }),
            // Commercial vehicle fields
            ...(commercialDetails.vehicleCategory && { vehicleCategory: commercialDetails.vehicleCategory }),
            ...(commercialDetails.vehicleLength && { vehicleLength: commercialDetails.vehicleLength }),
            ...(commercialDetails.cargoVolume && { cargoVolume: commercialDetails.cargoVolume }),
            ...(commercialDetails.seatingCapacity && { seatingCapacity: commercialDetails.seatingCapacity }),
            ...(commercialDetails.hasPanoramicRoof && { hasPanoramicRoof: commercialDetails.hasPanoramicRoof }),
          });
        }
      }
    }
  } catch (error) {
    console.error('Peugeot PDF parse error:', error);
  }

  return vehicles;
};

// === BYD Helper Functions ===

// BYD model specifications lookup table (from official website)
const BYD_SPECS: Record<string, { batteryCapacity: number; wltpRange: number; fuelConsumption: string }> = {
  // ATTO 2
  'ATTO 2-130': { batteryCapacity: 45.3, wltpRange: 312, fuelConsumption: '14.5 kWh/100km' },

  // DOLPHIN
  'DOLPHIN-150': { batteryCapacity: 60.5, wltpRange: 427, fuelConsumption: '15.9 kWh/100km' },

  // ATTO 3
  'ATTO 3-150': { batteryCapacity: 60.5, wltpRange: 420, fuelConsumption: '16.0 kWh/100km' },

  // SEAL U EV
  'SEAL U EV-160': { batteryCapacity: 71.8, wltpRange: 500, fuelConsumption: '20.5 kWh/100km' },

  // SEAL
  'SEAL-160': { batteryCapacity: 61.4, wltpRange: 460, fuelConsumption: '13.3 kWh/100km' },
  'SEAL-390': { batteryCapacity: 82.5, wltpRange: 520, fuelConsumption: '15.9 kWh/100km' },

  // SEALION 7
  'SEALION 7-160': { batteryCapacity: 82.5, wltpRange: 502, fuelConsumption: '16.4 kWh/100km' },
  'SEALION 7-390': { batteryCapacity: 91.3, wltpRange: 542, fuelConsumption: '16.8 kWh/100km' },

  // HAN
  'HAN-380': { batteryCapacity: 85.4, wltpRange: 521, fuelConsumption: '18.5 kWh/100km' },

  // TANG
  'TANG-380': { batteryCapacity: 108.8, wltpRange: 530, fuelConsumption: '24.0 kWh/100km' },
};

interface BYDEngineDetails {
  powerKW?: number;
  isElectric?: boolean;
  isHybrid?: boolean;
  driveType?: string;
}

function parseBYDEngineDetails(engine: string, variant: string): BYDEngineDetails {
  const details: BYDEngineDetails = {};
  const combined = `${engine} ${variant}`;

  // Power kW - extract from engine string like "BYD 130 kW" or "390kW AWD"
  const kwMatch = combined.match(/(\d+)\s*kW/i);
  if (kwMatch) {
    details.powerKW = parseInt(kwMatch[1], 10);
  }

  // Drive type
  if (/AWD/i.test(combined)) {
    details.driveType = 'AWD';
  } else {
    details.driveType = 'RWD';
  }

  // Electric vs Hybrid
  if (/DM-i|DMi|dm-i/i.test(combined)) {
    details.isHybrid = true;
    details.isElectric = false;
  } else {
    details.isElectric = true;
  }

  return details;
}

function getBYDSpecs(model: string, powerKW: number | undefined): {
  batteryCapacity?: number;
  wltpRange?: number;
  fuelConsumption?: string;
} {
  if (!powerKW) return {};

  const key = `${model}-${powerKW}`;
  return BYD_SPECS[key] || {};
}

// BYD parser - parses HTML data from bydauto.com.tr
const parseBYDData = (html: string, brand: string): PriceListRow[] => {
  const vehicles: PriceListRow[] = [];

  try {
    const $ = cheerio.load(html);

    // Find all vehicle sections (they have IDs starting with "vehicle-")
    $('[id^="vehicle-"]').each((_, section) => {
      const $section = $(section);

      // Get model name from h3.vehicle-name
      const modelName = $section.find('h3.vehicle-name').text().trim() ||
        $section.find('h3').first().text().trim() ||
        'Unknown';

      // Clean model name (remove "BYD" prefix if present)
      const cleanModel = modelName.replace(/^BYD\s+/i, '').trim();

      // Find the table and parse rows
      $section.find('table tbody tr').each((_, row) => {
        const $row = $(row);
        const cells = $row.find('td');

        if (cells.length >= 4) {
          const variant = $(cells[0]).text().trim();
          const trim = $(cells[1]).text().trim();
          const otvRateText = $(cells[2]).text().trim();
          const listPriceText = $(cells[3]).text().trim();
          // 5th column is campaign price (if exists)
          const campaignPriceText = cells.length >= 5 ? $(cells[4]).text().trim() : '';

          // Parse list price (Turkish format: 1.234.567 TL or 1.234.567,00 TL)
          const listPriceMatch = listPriceText.match(/[\d.]+(?:,\d+)?/);
          if (listPriceMatch) {
            const priceListNumeric = parsePrice(listPriceMatch[0]);

            // Skip if price is invalid
            if (priceListNumeric < 100000 || priceListNumeric > 50000000) return;

            // Parse campaign price if available
            let priceCampaignNumeric: number | undefined;
            const campaignMatch = campaignPriceText.match(/[\d.]+(?:,\d+)?/);
            if (campaignMatch) {
              const parsedCampaign = parsePrice(campaignMatch[0]);
              if (parsedCampaign >= 100000 && parsedCampaign < priceListNumeric) {
                priceCampaignNumeric = parsedCampaign;
              }
            }

            // Use campaign price if available, otherwise list price
            const priceNumeric = priceCampaignNumeric || priceListNumeric;

            // Use variant as engine info
            const engine = variant.replace(cleanModel, '').trim() || variant;

            // Parse engine details using helper
            const engineDetails = parseBYDEngineDetails(engine, variant);

            // Get specs from lookup table
            const specs = getBYDSpecs(cleanModel, engineDetails.powerKW);

            // Determine fuel type based on engine details
            const fuel = engineDetails.isHybrid ? 'Plug-in Hybrid' : 'Elektrik';

            // Parse OTV rate (e.g., "% 10" or "%10" -> 10)
            let parsedOtvRate: number | undefined;
            const otvMatch = otvRateText.match(/(\d+)/);
            if (otvMatch) {
              parsedOtvRate = parseInt(otvMatch[1], 10);
            }

            vehicles.push({
              model: cleanModel,
              trim,
              engine,
              transmission: 'Otomatik',
              fuel,
              priceRaw: priceCampaignNumeric ? campaignPriceText : listPriceText,
              priceNumeric,
              brand,
              // OTV
              ...(parsedOtvRate && { otvRate: parsedOtvRate }),
              // Price fields
              ...(priceListNumeric && { priceListNumeric }),
              ...(priceCampaignNumeric && { priceCampaignNumeric }),
              // Model year
              modelYear: new Date().getFullYear(),
              // Engine/Power fields
              ...(engineDetails.powerKW && { powerKW: engineDetails.powerKW }),
              ...(engineDetails.isElectric && { isElectric: engineDetails.isElectric }),
              ...(engineDetails.isHybrid && { isHybrid: engineDetails.isHybrid }),
              ...(engineDetails.driveType && { driveType: engineDetails.driveType }),
              // Specs from lookup
              ...(specs.batteryCapacity && { batteryCapacity: specs.batteryCapacity }),
              ...(specs.wltpRange && { wltpRange: specs.wltpRange }),
              ...(specs.fuelConsumption && { fuelConsumption: specs.fuelConsumption }),
            });
          }
        }
      });
    });

    // If no vehicles found with the structured approach, try a simpler table-based approach
    if (vehicles.length === 0) {
      $('table').each((_, table) => {
        const $table = $(table);

        // Find the parent section to get model name
        const $parent = $table.closest('[id^="vehicle-"]');
        let modelName = $parent.find('h3').first().text().trim() ||
          $table.prev('h3').text().trim() ||
          'Unknown';
        const cleanModel = modelName.replace(/^BYD\s+/i, '').trim();

        $table.find('tbody tr').each((_, row) => {
          const $row = $(row);
          const cells = $row.find('td');

          if (cells.length >= 2) {
            // Try to find price in last cell
            const lastCell = $(cells[cells.length - 1]).text().trim();
            const priceMatch = lastCell.match(/[\d.]+(?:,\d+)?/);

            if (priceMatch) {
              const priceNumeric = parsePrice(priceMatch[0]);
              if (priceNumeric < 100000 || priceNumeric > 50000000) return;

              const variant = cells.length >= 1 ? $(cells[0]).text().trim() : '';
              const trim = cells.length >= 2 ? $(cells[1]).text().trim() : '';

              // Parse engine details using helper
              const engineDetails = parseBYDEngineDetails(variant, '');
              const specs = getBYDSpecs(cleanModel || variant, engineDetails.powerKW);
              const fuel = engineDetails.isHybrid ? 'Plug-in Hybrid' : 'Elektrik';

              vehicles.push({
                model: cleanModel || variant,
                trim: trim || variant,
                engine: variant,
                transmission: 'Otomatik',
                fuel,
                priceRaw: lastCell,
                priceNumeric,
                brand,
                modelYear: new Date().getFullYear(),
                ...(engineDetails.powerKW && { powerKW: engineDetails.powerKW }),
                ...(engineDetails.isElectric && { isElectric: engineDetails.isElectric }),
                ...(engineDetails.isHybrid && { isHybrid: engineDetails.isHybrid }),
                ...(engineDetails.driveType && { driveType: engineDetails.driveType }),
                ...(specs.batteryCapacity && { batteryCapacity: specs.batteryCapacity }),
                ...(specs.wltpRange && { wltpRange: specs.wltpRange }),
                ...(specs.fuelConsumption && { fuelConsumption: specs.fuelConsumption }),
              });
            }
          }
        });
      });
    }
  } catch (error) {
    console.error('BYD HTML parse error:', error);
  }

  return vehicles;
};

// Opel engine details parser
interface OpelEngineDetails {
  powerHP?: number;           // 100, 130, 136
  powerKW?: number;           // 100, 115, 157
  engineDisplacement?: string; // "1.2L", "1.5L"
  batteryCapacity?: number;   // 44, 54
  isElectric?: boolean;
  isHybrid?: boolean;
  hasLongRange?: boolean;
}

function parseOpelEngineDetails(engine: string): OpelEngineDetails {
  const details: OpelEngineDetails = {};

  // Battery capacity (kWh) - check first
  const batteryMatch = engine.match(/(\d+)\s*kWh/i);
  if (batteryMatch) {
    details.batteryCapacity = parseInt(batteryMatch[1], 10);
    details.isElectric = true;
  }

  // Power kW (electric vehicles) - but not kWh
  const kwMatch = engine.match(/(\d+)\s*kW(?!h)/i);
  if (kwMatch) {
    details.powerKW = parseInt(kwMatch[1], 10);
    details.isElectric = true;
  }

  // Power HP - check for parentheses format first (Hybrid 1.2 145 (136HP))
  const hpParenMatch = engine.match(/\((\d+)\s*HP\)/i);
  if (hpParenMatch) {
    details.powerHP = parseInt(hpParenMatch[1], 10);
  } else {
    // Standard HP format: 100 HP, 130 HP
    const hpMatch = engine.match(/(\d+)\s*HP/i);
    if (hpMatch) {
      details.powerHP = parseInt(hpMatch[1], 10);
    }
  }

  // Engine displacement - look for patterns like "1.2 100 HP" or "Hybrid 1.2 145"
  const dispMatch = engine.match(/(\d+\.\d+)\s+\d+/);
  if (dispMatch) {
    details.engineDisplacement = dispMatch[1] + 'L';
  }

  // Hybrid detection
  if (/Hybrid/i.test(engine)) {
    details.isHybrid = true;
  }

  // Electric detection (if not already set)
  if (/Elektrik/i.test(engine) && !details.isElectric) {
    details.isElectric = true;
  }

  // Long range detection
  if (/Uzun\s*Menzil/i.test(engine)) {
    details.hasLongRange = true;
  }

  return details;
}

// Opel parser - parses HTML data from fiyatlisteleri.opel.com.tr
// Each model has its own page, so this parser handles a single page
const parseOpelData = (html: string, brand: string, modelName?: string): PriceListRow[] => {
  const vehicles: PriceListRow[] = [];

  try {
    const $ = cheerio.load(html);

    // Get model name from page title if not provided
    let model = modelName || '';
    if (!model) {
      const titleText = $('title').text().trim();
      // Title format: "Opel Corsa Fiyat Listesi"
      const titleMatch = titleText.match(/Opel\s+(.+?)\s+Fiyat\s+Listesi/i);
      if (titleMatch) {
        model = titleMatch[1].trim();
      }
    }

    // Clean up model name
    model = model
      .replace(/^yeni-/i, '')
      .replace(/-/g, ' ')
      .split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');

    // Find the versions table
    const $table = $('table.versions');
    if ($table.length === 0) {
      console.log(`    Warning: No versions table found for ${model}`);
      return vehicles;
    }

    // Parse each row in tbody
    $table.find('tbody tr').each((_, row) => {
      const $row = $(row);
      const cells = $row.find('td');

      if (cells.length < 3) return;

      // First cell: Motor / Şanzıman
      const motorCell = $(cells[0]);
      const engineSpan = motorCell.find('span').first().text().trim();
      // Transmission is typically after <br>
      const motorHtml = motorCell.html() || '';
      const transmissionMatch = motorHtml.match(/<br\s*\/?>\s*(\w+)/i);
      const transmission = transmissionMatch ? transmissionMatch[1].trim() : '';

      // Determine fuel type from engine info
      let fuel = '';
      const engineLower = engineSpan.toLowerCase();
      if (engineLower.includes('elektrik') || engineLower.includes('kw')) {
        fuel = 'Elektrik';
      } else if (engineLower.includes('hybrid')) {
        fuel = 'Hybrid';
      } else if (engineLower.includes('dizel')) {
        fuel = 'Dizel';
      } else if (engineLower.includes('benzin')) {
        fuel = 'Benzin';
      }

      // Map transmission codes
      let mappedTransmission = transmission;
      const transLower = transmission.toLowerCase();
      if (transLower.includes('mt') || transLower === 'manuel') {
        mappedTransmission = 'Manuel';
      } else if (
        transLower.includes('at') ||
        transLower.includes('dct') ||
        transLower === 'otomatik' ||
        transLower.startsWith('e-') ||
        transLower === 'e' // e-DCT captured as just 'e'
      ) {
        mappedTransmission = 'Otomatik';
      }

      // Second cell: Donanım (trim) - can have multiple spans
      const trimCell = $(cells[1]);
      const trims: string[] = [];
      trimCell.find('span').each((_, span) => {
        const trimText = $(span).text().trim();
        if (trimText && trimText.length > 0) {
          trims.push(trimText);
        }
      });

      // Price columns (3rd, 4th, 5th cells) - prefer MY26 price, then MY25, then campaign
      // MY25 price is in cell[2], campaign in cell[3], MY26 in cell[4]
      const priceColumns: string[][] = [];
      for (let i = 2; i < cells.length; i++) {
        const priceCell = $(cells[i]);
        const prices: string[] = [];
        priceCell.find('span').each((_, span) => {
          const priceText = $(span).text().trim();
          if (priceText && priceText.includes('TL')) {
            prices.push(priceText);
          }
        });
        priceColumns.push(prices);
      }

      // Match trims with prices
      // Each trim should have corresponding prices in each column
      trims.forEach((trim, trimIndex) => {
        // Extract all three price columns:
        // priceColumns[0] = MY25 price
        // priceColumns[1] = Campaign price
        // priceColumns[2] = MY26 price
        const priceMY25Text = priceColumns[0]?.[trimIndex] || '';
        const priceCampaignText = priceColumns[1]?.[trimIndex] || '';
        const priceMY26Text = priceColumns[2]?.[trimIndex] || '';

        // Parse all prices
        const priceMY25 = priceMY25Text ? parsePrice(priceMY25Text) : 0;
        const priceCampaign = priceCampaignText ? parsePrice(priceCampaignText) : 0;
        const priceMY26 = priceMY26Text ? parsePrice(priceMY26Text) : 0;

        // Find the best price: prefer MY26, then campaign, then MY25
        let priceText = '';
        let priceNumeric = 0;
        let modelYear: number | undefined;

        if (isValidPrice(priceMY26)) {
          priceText = priceMY26Text;
          priceNumeric = priceMY26;
          modelYear = 2026;
        } else if (isValidPrice(priceCampaign)) {
          priceText = priceCampaignText;
          priceNumeric = priceCampaign;
          modelYear = 2025;
        } else if (isValidPrice(priceMY25)) {
          priceText = priceMY25Text;
          priceNumeric = priceMY25;
          modelYear = 2025;
        }

        if (!priceText || !isValidPrice(priceNumeric)) return;

        // Check for duplicate
        const exists = vehicles.find(
          v => v.model === model &&
            v.trim === trim &&
            v.engine === engineSpan &&
            v.transmission === mappedTransmission
        );

        if (!exists) {
          // Determine list price (MY25 or MY26 original) and campaign price
          const priceListNumeric = isValidPrice(priceMY25) ? priceMY25 : (isValidPrice(priceMY26) ? priceMY26 : undefined);
          const priceCampaignNumeric = isValidPrice(priceCampaign) ? priceCampaign : undefined;

          // Parse engine details using helper
          const engineDetails = parseOpelEngineDetails(engineSpan);

          vehicles.push({
            model,
            trim,
            engine: engineSpan,
            transmission: mappedTransmission,
            fuel,
            priceRaw: priceText,
            priceNumeric,
            brand,
            ...(modelYear && { modelYear }),
            ...(priceListNumeric && { priceListNumeric }),
            ...(priceCampaignNumeric && { priceCampaignNumeric }),
            // Engine/Power fields
            ...(engineDetails.powerHP && { powerHP: engineDetails.powerHP }),
            ...(engineDetails.powerKW && { powerKW: engineDetails.powerKW }),
            ...(engineDetails.engineDisplacement && { engineDisplacement: engineDetails.engineDisplacement }),
            ...(engineDetails.batteryCapacity && { batteryCapacity: engineDetails.batteryCapacity }),
            ...(engineDetails.isElectric && { isElectric: engineDetails.isElectric }),
            ...(engineDetails.isHybrid && { isHybrid: engineDetails.isHybrid }),
            ...(engineDetails.hasLongRange && { hasLongRange: engineDetails.hasLongRange }),
          });
        }
      });
    });
  } catch (error) {
    console.error('Opel HTML parse error:', error);
  }

  return vehicles;
};

// BMW engine details parser
interface BMWEngineDetails {
  powerHP?: number;           // 258, 480, 218
  powerHPSecondary?: number;  // 20, 109, 197 (hybrid secondary)
  engineDisplacement?: string; // "2.0L", "3.0L", "4.4L"
  isElectric?: boolean;
  isHybrid?: boolean;
  isMildHybrid?: boolean;
  isPlugInHybrid?: boolean;
  driveType?: string;         // "AWD", "RWD"
}

function parseBMWEngineDetails(engine: string, fuel: string, model: string): BMWEngineDetails {
  const details: BMWEngineDetails = {};
  const fuelLower = fuel.toLowerCase();

  // Engine displacement - "2.0L", "3.0L", "4.4L"
  const dispMatch = engine.match(/(\d+\.\d+)L/);
  if (dispMatch) {
    details.engineDisplacement = dispMatch[1] + 'L';
  }

  // Power HP - handle hybrid format "258+20 HP" or standard "258 HP"
  const hybridHPMatch = engine.match(/(\d+)\+(\d+)\s*HP/i);
  if (hybridHPMatch) {
    details.powerHP = parseInt(hybridHPMatch[1], 10);
    details.powerHPSecondary = parseInt(hybridHPMatch[2], 10);
  } else {
    const hpMatch = engine.match(/(\d+)\s*HP/i);
    if (hpMatch) {
      details.powerHP = parseInt(hpMatch[1], 10);
    }
  }

  // Electric detection
  if (fuelLower.includes('elektrik') || fuelLower.includes('electric')) {
    details.isElectric = true;
  }

  // Hybrid detection
  if (fuelLower.includes('plug-in hybrid') || fuelLower.includes('plug-in hibrit')) {
    details.isHybrid = true;
    details.isPlugInHybrid = true;
  } else if (fuelLower.includes('mild hybrid') || fuelLower.includes('mild hibrit')) {
    details.isHybrid = true;
    details.isMildHybrid = true;
  } else if (fuelLower.includes('hybrid') || fuelLower.includes('hibrit')) {
    details.isHybrid = true;
  }

  // Drive type from model name
  if (/xDrive/i.test(model)) {
    details.driveType = 'AWD';
  } else if (/sDrive/i.test(model)) {
    details.driveType = 'RWD';
  }

  return details;
}

// BMW parser - parses HTML data from borusanotomotiv.com
const parseBMWData = (html: string, brand: string): PriceListRow[] => {
  const vehicles: PriceListRow[] = [];

  try {
    const $ = cheerio.load(html);

    // Track current model for rows that don't have model name
    let currentModel = '';

    // Find all series sections
    $('div.Series').each((_, section) => {
      const $section = $(section);

      // Get series name from h1
      const seriesName = $section.find('h1').first().text().trim();
      if (!seriesName) return;

      // Reset current model for each series
      currentModel = '';

      // Find all vehicle rows (line_ divs)
      $section.find('div[class*="line_"]').each((_, row) => {
        const $row = $(row);

        // Extract cell texts from direct children only
        const cells: string[] = [];
        $row.children('div').each((_, cell) => {
          const text = $(cell).text().trim().replace(/\s+/g, ' ');
          cells.push(text);
        });

        if (cells.length < 10) return;

        // Column mapping from HTML structure (11 columns):
        // [0]: Model name + "Online rezerve edin"
        // [1]: Tasarım Paketi (trim)
        // [2]: Model Yılı (often empty)
        // [3]: Şanzıman
        // [4]: Yakıt Tipi
        // [5]: Motor Hacmi
        // [6]: Motor Gücü
        // [7]: Yakıt Tüketimi
        // [8]: ÖTV Oranı
        // [9]: Azami Anahtar Teslim Satış Fiyatı
        // [10]: Aylık Kiralama

        // Extract model name (remove "Online rezerve edin" text)
        let modelCell = cells[0]?.replace(/Online rezerve edin/gi, '').trim() || '';

        // If model cell has content, update current model
        if (modelCell.length >= 3) {
          currentModel = modelCell;
        }

        const model = currentModel || seriesName;
        const trim = cells[1] || '';
        const modelYearRaw = cells[2]?.trim() || '';
        const transmission = cells[3] || '';
        const fuelType = cells[4] || '';
        const engineCC = cells[5] || '';
        const engineHP = cells[6] || '';

        // Price is in cell[9]
        const priceText = cells[9] || '';
        if (!priceText || !/^\d{1,3}(?:\.\d{3})+$/.test(priceText)) return;

        const priceNumeric = parsePrice(priceText);
        if (!isValidPrice(priceNumeric)) return;

        // Determine fuel type
        let fuel = '';
        const fuelLower = fuelType.toLowerCase();
        if (fuelLower.includes('elektrik')) {
          fuel = 'Elektrik';
        } else if (fuelLower.includes('plug-in hybrid')) {
          fuel = 'Plug-in Hybrid';
        } else if (fuelLower.includes('mild hybrid')) {
          fuel = 'Mild Hybrid';
        } else if (fuelLower.includes('hybrid')) {
          fuel = 'Hybrid';
        } else if (fuelLower.includes('dizel') || fuelLower.includes('diesel')) {
          fuel = 'Dizel';
        } else if (fuelLower.includes('benzin') || fuelLower.includes('petrol')) {
          fuel = 'Benzin';
        }

        // Build engine info
        let engine = '';
        // For electric vehicles, engineCC is kW not displacement, so don't add "L"
        const isElectric = fuelLower.includes('elektrik') || fuelLower.includes('electric');
        if (engineCC && /^\d/.test(engineCC) && !isElectric) {
          // Only add "L" for non-electric vehicles where this is actual displacement
          const ccValue = parseFloat(engineCC.replace(',', '.'));
          if (ccValue >= 0.8 && ccValue <= 8) {
            // Already in liters (e.g., "2.0")
            engine = ccValue.toFixed(1) + 'L';
          } else if (ccValue >= 800 && ccValue <= 8000) {
            // In cc, convert to liters
            engine = (ccValue / 1000).toFixed(1) + 'L';
          }
        }
        if (engineHP) {
          // Clean HP: "156 + 20* bg" -> "156+20 HP"
          const hpClean = engineHP.replace(/\s*\*+\s*/g, '').replace(/\s*bg\s*/gi, '').replace(/\s+/g, '').trim();
          engine = engine ? `${engine} ${hpClean} HP` : `${hpClean} HP`;
        }

        // Map transmission
        let mappedTransmission = 'Otomatik';
        if (transmission.toLowerCase().includes('manuel')) {
          mappedTransmission = 'Manuel';
        }

        // Check for duplicate (by model+trim+price, not engine - engine can vary slightly)
        const exists = vehicles.find(
          v => v.model === model &&
            v.trim === trim &&
            v.priceNumeric === priceNumeric
        );

        if (!exists && model && trim) {
          // Extract additional fields from HTML columns
          // cells[7] = Yakıt Tüketimi
          // cells[8] = ÖTV Oranı
          // cells[10] = Aylık Kiralama
          const fuelConsumptionRaw = cells[7]?.trim() || '';
          const otvRaw = cells[8]?.trim() || '';
          const monthlyLeaseRaw = cells[10]?.trim() || '';

          // Parse OTV rate (e.g., "% 60" -> 60)
          let otvRate: number | undefined;
          const otvMatch = otvRaw.match(/(\d+)/);
          if (otvMatch) {
            otvRate = parseInt(otvMatch[1], 10);
          }

          // Parse monthly lease (e.g., "42.500" -> 42500)
          let monthlyLease: number | undefined;
          if (monthlyLeaseRaw && /^\d/.test(monthlyLeaseRaw)) {
            monthlyLease = parsePrice(monthlyLeaseRaw);
            if (!monthlyLease || monthlyLease < 1000) monthlyLease = undefined;
          }

          // Fuel consumption is already a string (e.g., "6.2 L/100km")
          const fuelConsumption = fuelConsumptionRaw && fuelConsumptionRaw.length > 0 ? fuelConsumptionRaw : undefined;

          // Parse engine details using helper
          const engineDetails = parseBMWEngineDetails(engine, fuel, model);

          // Parse model year (e.g., "2025", "2026")
          const parsedModelYear = modelYearRaw.match(/(\d{4})/) ? parseInt(modelYearRaw.match(/(\d{4})/)![1], 10) : undefined;

          vehicles.push({
            model,
            trim,
            engine,
            transmission: mappedTransmission,
            fuel,
            priceRaw: priceNumeric.toLocaleString('tr-TR') + ' TL',
            priceNumeric,
            brand,
            ...(parsedModelYear && { modelYear: parsedModelYear }),
            ...(fuelConsumption && { fuelConsumption }),
            ...(otvRate && { otvRate }),
            ...(monthlyLease && { monthlyLease }),
            // Engine/Power fields
            ...(engineDetails.powerHP && { powerHP: engineDetails.powerHP }),
            ...(engineDetails.powerHPSecondary && { powerHPSecondary: engineDetails.powerHPSecondary }),
            ...(engineDetails.engineDisplacement && { engineDisplacement: engineDetails.engineDisplacement }),
            ...(engineDetails.isElectric && { isElectric: engineDetails.isElectric }),
            ...(engineDetails.isHybrid && { isHybrid: engineDetails.isHybrid }),
            ...(engineDetails.isMildHybrid && { isMildHybrid: engineDetails.isMildHybrid }),
            ...(engineDetails.isPlugInHybrid && { isPlugInHybrid: engineDetails.isPlugInHybrid }),
            ...(engineDetails.driveType && { driveType: engineDetails.driveType }),
          });
        }
      });
    });
  } catch (error) {
    console.error('BMW HTML parse error:', error);
  }

  return vehicles;
};

// Mercedes-Benz extended details helper
interface MercedesExtendedDetails {
  powerHP?: number;
  engineDisplacement?: string;
  isElectric?: boolean;
  isHybrid?: boolean;
  driveType?: string;
  isAMG?: boolean;
}

function parseMercedesExtendedDetails(
  motorGucu: string,
  motorHacmi: string,
  fuel: string,
  model: string
): MercedesExtendedDetails {
  const details: MercedesExtendedDetails = {};
  const fuelLower = fuel.toLowerCase();
  const modelUpper = model.toUpperCase();

  // Power HP - directly from motor-gucu attribute
  if (motorGucu) {
    const hp = parseInt(motorGucu.replace(/[^0-9]/g, ''), 10);
    if (!isNaN(hp) && hp > 0) {
      details.powerHP = hp;
    }
  }

  // Engine displacement - convert CC to Liters
  if (motorHacmi) {
    const cc = parseFloat(motorHacmi.replace(',', '.'));
    if (!isNaN(cc) && cc > 0) {
      // Convert CC to liters (e.g., 1332 -> 1.3L, 1991 -> 2.0L)
      const liters = cc > 100 ? (cc / 1000).toFixed(1) : cc.toFixed(1);
      details.engineDisplacement = liters + 'L';
    }
  }

  // Hybrid detection (check first, as hybrids may have "Elektrik" fuel type in API)
  const isEPerformance = modelUpper.includes('E PERFORMANCE');
  const hasHybridInModel = /\bHybrid\b/i.test(model);
  const isHybridModel = fuelLower.includes('hybrid') || fuelLower.includes('hibrit') ||
    isEPerformance || hasHybridInModel;
  if (isHybridModel) {
    details.isHybrid = true;
  }

  // Electric detection - fuel type or EQ model prefix (exclude all hybrids)
  if (!isHybridModel && (
    fuelLower.includes('elektrik') || fuelLower.includes('electric') ||
    modelUpper.startsWith('EQ') || modelUpper.includes('G 580'))) {
    details.isElectric = true;
  }

  // Drive type from model name - 4MATIC = AWD
  if (/4MATIC/i.test(model)) {
    details.driveType = 'AWD';
  }

  // AMG detection - actual performance models (not just AMG Line trim)
  // Matches: AMG A 35, AMG A 45, AMG C 43, AMG C 63, AMG GT 63, Mercedes-AMG, etc.
  if (/\bAMG\s+\w+\s*\d{2}/i.test(model) || /Mercedes-AMG/i.test(model)) {
    details.isAMG = true;
  }

  return details;
}

// Mercedes-Benz parser - parses JSON data from pladmin.mercedes-benz.com.tr API
const parseMercedesData = (data: any, brand: string): PriceListRow[] => {
  const vehicles: PriceListRow[] = [];

  try {
    if (!data?.success || !Array.isArray(data.result)) {
      console.log('    Warning: Invalid Mercedes API response');
      return vehicles;
    }

    for (const item of data.result) {
      // Skip inactive products
      if (!item.IsActive) continue;

      const modelName = item.Name || '';
      const modelYear = item.GroupName || '';

      // Get price from ProductPrice array
      const priceInfo = item.ProductPrice?.[0];
      if (!priceInfo) continue;

      const actualPrice = priceInfo.ActualPrice || 0;
      const basePrice = priceInfo.BasePrice || 0;
      const priceNumeric = actualPrice || basePrice;
      if (!isValidPrice(priceNumeric)) continue;

      // List vs campaign price (only if different)
      const priceListNumeric = basePrice > 0 && basePrice !== actualPrice ? basePrice : undefined;
      const priceCampaignNumeric = actualPrice > 0 && basePrice > 0 && actualPrice < basePrice ? actualPrice : undefined;

      // Extract attributes from ProductAttribute array
      const attributes: { [key: string]: string } = {};
      if (Array.isArray(item.ProductAttribute)) {
        for (const attr of item.ProductAttribute) {
          if (attr.AttributeCode && attr.Value) {
            attributes[attr.AttributeCode] = attr.Value;
          }
        }
      }

      // Get trim/package
      const trim = attributes['donanim-paketi'] || '';

      // Get transmission
      let transmission = attributes['sanziman-tipi'] || '';
      if (transmission.includes('DCT') || transmission.includes('SPEEDSHIFT') || transmission.includes('G-TRONIC')) {
        transmission = 'Otomatik';
      }

      // Get fuel type
      let fuel = attributes['yakit'] || '';
      if (fuel.toLowerCase().includes('elektrik')) {
        fuel = 'Elektrik';
      } else if (fuel.toLowerCase().includes('hybrid') || fuel.toLowerCase().includes('hibrit')) {
        fuel = 'Hybrid';
      } else if (fuel.toLowerCase().includes('dizel')) {
        fuel = 'Dizel';
      } else if (fuel.toLowerCase().includes('benzin')) {
        fuel = 'Benzin';
      }

      // Build engine info
      const engineCC = attributes['motor-hacmi'] || '';
      const engineHP = attributes['motor-gucu'] || '';
      let engine = '';
      if (engineCC) {
        // Format: "1.332" -> "1.3L" or "1991" -> "2.0L"
        const ccNum = parseFloat(engineCC.replace(',', '.'));
        // Only add displacement if it's a valid number (electric vehicles don't have this)
        if (!isNaN(ccNum) && ccNum > 0) {
          if (ccNum > 100) {
            // It's in cc, convert to liters
            engine = (ccNum / 1000).toFixed(1) + 'L';
          } else {
            engine = ccNum.toFixed(1) + 'L';
          }
        }
      }
      if (engineHP) {
        // For electric vehicles, just show HP without displacement
        const hpValue = engineHP.replace(/[^0-9]/g, '');
        engine = engine ? `${engine} ${hpValue} HP` : `${hpValue} HP`;
      }

      // Check for duplicate
      const exists = vehicles.find(
        v => v.model === modelName &&
          v.trim === trim &&
          v.priceNumeric === priceNumeric
      );

      if (!exists && modelName) {
        // Extract OTV rate from item (TaxRatio field in API response)
        const taxRatio = item.TaxRatio;
        const otvRate = typeof taxRatio === 'number' && taxRatio > 0 ? taxRatio : undefined;

        // Get extended details using helper
        const motorGucu = attributes['motor-gucu'] || '';
        const motorHacmi = attributes['motor-hacmi'] || '';
        const extendedDetails = parseMercedesExtendedDetails(motorGucu, motorHacmi, fuel, modelName);

        vehicles.push({
          model: modelName,
          trim: trim || modelYear,
          engine,
          transmission: transmission || 'Otomatik',
          fuel,
          priceRaw: priceNumeric.toLocaleString('tr-TR') + ' TL',
          priceNumeric,
          brand,
          // Existing fields
          ...(otvRate && { otvRate }),
          // New fields from API
          ...(modelYear && { modelYear }),
          ...(priceListNumeric && { priceListNumeric }),
          ...(priceCampaignNumeric && { priceCampaignNumeric }),
          // Extended details
          ...(extendedDetails.powerHP && { powerHP: extendedDetails.powerHP }),
          ...(extendedDetails.engineDisplacement && { engineDisplacement: extendedDetails.engineDisplacement }),
          ...(extendedDetails.isElectric && { isElectric: extendedDetails.isElectric }),
          ...(extendedDetails.isHybrid && { isHybrid: extendedDetails.isHybrid }),
          ...(extendedDetails.driveType && { driveType: extendedDetails.driveType }),
          ...(extendedDetails.isAMG && { isAMG: extendedDetails.isAMG }),
        });
      }
    }
  } catch (error) {
    console.error('Mercedes parse error:', error);
  }

  return vehicles;
};

// Ford engine details helper
interface FordEngineDetails {
  powerHP?: number;
  powerKW?: number;
  engineDisplacement?: string;
  engineType?: string;
  isHybrid?: boolean;
  isElectric?: boolean;
}

function parseFordEngineDetails(engine: string, fuel: string): FordEngineDetails {
  const details: FordEngineDetails = {};
  const fuelLower = fuel.toLowerCase();

  // Engine displacement - "1.0L", "1.5L", "2.5L"
  const dispMatch = engine.match(/(\d+\.\d+)L/i);
  if (dispMatch) {
    details.engineDisplacement = dispMatch[1] + 'L';
  }

  // Power HP - "125PS", "150PS" (PS = HP in metric)
  const hpMatch = engine.match(/(\d+)\s*PS/i);
  if (hpMatch) {
    details.powerHP = parseInt(hpMatch[1], 10);
  } else {
    // Electric vehicles: "100KW", "123KW" - convert kW to HP (1 kW ≈ 1.34 HP)
    const kwMatch = engine.match(/(\d+)\s*KW/i);
    if (kwMatch) {
      const kw = parseInt(kwMatch[1], 10);
      details.powerKW = kw;
      details.powerHP = Math.round(kw * 1.34);
    }
  }

  // Engine type - EcoBoost, EcoBlue, Duratec
  if (/EcoBoost/i.test(engine)) {
    details.engineType = 'EcoBoost';
  } else if (/EcoBlue/i.test(engine)) {
    details.engineType = 'EcoBlue';
  } else if (/Duratec/i.test(engine)) {
    details.engineType = 'Duratec';
  }

  // Hybrid detection - from fuel type or engine string
  if (fuelLower.includes('hibrit') || fuelLower.includes('hybrid') ||
    /Hybrid/i.test(engine) || fuelLower === 'benzin/hibrit') {
    details.isHybrid = true;
  }

  // Electric detection
  if (fuelLower.includes('elektrik') || fuelLower.includes('electric')) {
    details.isElectric = true;
  }

  return details;
}

// Ford parser - parses JSON data from ford.com.tr API
const parseFordData = (data: any, brand: string): PriceListRow[] => {
  const vehicles: PriceListRow[] = [];

  try {
    const carPriceList = data?.carPriceList;
    if (!Array.isArray(carPriceList)) {
      console.log('    Warning: No carPriceList array found');
      return vehicles;
    }

    for (const model of carPriceList) {
      const modelName = model.modelName || '';
      const entities = model.entities;
      const origin = model.carProductionPlace || undefined; // Üretim yeri (menşei)

      if (!Array.isArray(entities)) continue;

      for (const entity of entities) {
        const series = entity.series || ''; // trim level
        const engine = entity.engine || '';
        const fuelType = entity.fuelType || '';
        const gearbox = entity.gearbox || '';

        // New fields from API
        const modelYear = entity.modelYear || undefined;
        const vehicleCategory = entity.body || undefined;
        const emissionStandard = entity.emission || undefined;

        // Parse optional equipment
        const options = entity.options;
        let optionalEquipment: { name: string; price: number }[] | undefined;
        if (Array.isArray(options) && options.length > 0) {
          optionalEquipment = options
            .filter((opt: any) => opt.carOption && opt.deliveredTurnkeyPrice)
            .map((opt: any) => ({
              name: opt.carOption,
              price: parseInt(opt.deliveredTurnkeyPrice, 10) || 0,
            }));
          if (optionalEquipment.length === 0) optionalEquipment = undefined;
        }

        // Extract both list and campaign prices
        const listPriceStr = entity.deliveredTurnkeyListPrice || '';
        const campaignPriceStr = entity.campaignedTurnkeyPrice || '';
        const priceStr = campaignPriceStr || listPriceStr;

        if (!priceStr) continue;

        const priceNumeric = parseInt(priceStr, 10);
        if (!isValidPrice(priceNumeric)) continue;

        // Parse list and campaign prices separately
        const priceListNumeric = listPriceStr ? parseInt(listPriceStr, 10) : undefined;
        const priceCampaignNumeric = campaignPriceStr ? parseInt(campaignPriceStr, 10) : undefined;

        // Map fuel type
        let fuel = '';
        const fuelLower = fuelType.toLowerCase();
        if (fuelLower.includes('elektrik')) {
          fuel = 'Elektrik';
        } else if (fuelLower.includes('hibrit') || fuelLower.includes('hybrid')) {
          fuel = 'Hybrid';
        } else if (fuelLower.includes('dizel') || fuelLower.includes('diesel')) {
          fuel = 'Dizel';
        } else if (fuelLower.includes('benzin')) {
          fuel = 'Benzin';
        }

        // Map transmission
        let transmission = '';
        const gearboxLower = gearbox.toLowerCase();
        if (gearboxLower.includes('otomatik') || gearboxLower.includes('powershift') || gearboxLower.includes('selectshift')) {
          transmission = 'Otomatik';
        } else if (gearboxLower.includes('manuel') || gearboxLower.includes('manual')) {
          transmission = 'Manuel';
        }

        // Check for duplicate
        const exists = vehicles.find(
          v => v.model === modelName &&
            v.trim === series &&
            v.engine === engine &&
            v.priceNumeric === priceNumeric
        );

        if (!exists && modelName && series) {
          // Get engine details using helper
          const engineDetails = parseFordEngineDetails(engine, fuel);

          vehicles.push({
            model: modelName,
            trim: series,
            engine,
            transmission,
            fuel,
            priceRaw: priceNumeric.toLocaleString('tr-TR') + ' TL',
            priceNumeric,
            brand,
            // Existing fields
            ...(priceListNumeric && isValidPrice(priceListNumeric) && { priceListNumeric }),
            ...(priceCampaignNumeric && isValidPrice(priceCampaignNumeric) && { priceCampaignNumeric }),
            // New fields from API
            ...(modelYear && { modelYear }),
            ...(origin && { origin }),
            ...(vehicleCategory && { vehicleCategory }),
            ...(emissionStandard && { emissionStandard }),
            ...(optionalEquipment && { optionalEquipment }),
            // Engine details from helper
            ...(engineDetails.powerHP && { powerHP: engineDetails.powerHP }),
            ...(engineDetails.powerKW && { powerKW: engineDetails.powerKW }),
            ...(engineDetails.engineDisplacement && { engineDisplacement: engineDetails.engineDisplacement }),
            ...(engineDetails.engineType && { engineType: engineDetails.engineType }),
            ...(engineDetails.isHybrid && { isHybrid: engineDetails.isHybrid }),
            ...(engineDetails.isElectric && { isElectric: engineDetails.isElectric }),
          });
        }
      }
    }
  } catch (error) {
    console.error('Ford parse error:', error);
  }

  return vehicles;
};

// Nissan engine details parser - extracts detailed info from version strings
interface NissanEngineDetails {
  powerHP?: number;           // 115, 158, 163, 190
  engineDisplacement?: string; // "1.0L", "1.3L", "1.5L"
  engineType?: string;        // "DIG-T", "VC-T", "e-POWER"
  transmissionType?: string;  // "6MT", "DCT", "CVT", "Auto"
  isHybrid?: boolean;
  isMildHybrid?: boolean;
  isElectric?: boolean;
}

function parseNissanEngineDetails(versionStr: string, fuelType: string): NissanEngineDetails {
  const details: NissanEngineDetails = {};
  const fuelLower = fuelType.toLowerCase();

  // Power HP - "158PS", "190PS", "115PS"
  const hpMatch = versionStr.match(/(\d{2,3})\s*PS/i);
  if (hpMatch) {
    details.powerHP = parseInt(hpMatch[1], 10);
  }

  // Engine displacement - "1.3", "1.0", "1.5" followed by DIG-T, VC-T, dCi, or space
  const dispMatch = versionStr.match(/(\d+\.\d+)\s*(?:DIG-T|VC-T|dCi|\s)/i);
  if (dispMatch) {
    details.engineDisplacement = dispMatch[1] + 'L';
  }

  // Engine type - DIG-T, VC-T, e-POWER, dCi
  if (/DIG-T/i.test(versionStr)) {
    details.engineType = 'DIG-T';
  } else if (/VC-T/i.test(versionStr)) {
    details.engineType = 'VC-T';
  } else if (/e-POWER/i.test(versionStr)) {
    details.engineType = 'e-POWER';
  } else if (/dCi/i.test(versionStr)) {
    details.engineType = 'dCi';
  }

  // Transmission type - 6MT, DCT, CVT/X-Tronic, Auto
  if (/\b6MT\b/i.test(versionStr)) {
    details.transmissionType = '6MT';
  } else if (/\bDCT\b/i.test(versionStr)) {
    details.transmissionType = 'DCT';
  } else if (/X-Tronic|CVT/i.test(versionStr)) {
    details.transmissionType = 'CVT';
  } else if (/\bAuto\b/i.test(versionStr)) {
    details.transmissionType = 'Auto';
  }

  // Mild Hybrid detection (check first)
  if (/Mild\s*Hybrid/i.test(versionStr) || fuelLower.includes('mild hybrid')) {
    details.isMildHybrid = true;
    details.isHybrid = true;
  }
  // e-POWER hybrid detection
  else if (/e-POWER/i.test(versionStr) || fuelLower.includes('e-power')) {
    details.isHybrid = true;
  }

  // Electric detection (EV models)
  if (/\bEV\b/i.test(versionStr) || fuelLower.includes('elektrik') ||
    fuelLower.includes('electric') || fuelLower === 'ev') {
    details.isElectric = true;
  }

  return details;
}

// Nissan parser - parses HTML data from nissan.com.tr
const parseNissanData = (html: string, brand: string): PriceListRow[] => {
  const vehicles: PriceListRow[] = [];

  try {
    const $ = cheerio.load(html);

    // Extract model year from page title/heading
    let nissanModelYear: number | undefined;
    const nissanPageText = $('title').text() + ' ' + $('h1').text() + ' ' + $('h2.heading span').first().text();
    const nissanYearMatch = nissanPageText.match(/\b(202[4-9]|203\d)\b/);
    if (nissanYearMatch) {
      nissanModelYear = parseInt(nissanYearMatch[1], 10);
    }

    // Collect model names from h2.heading and h3.heading spans (filter out "-" placeholders)
    const modelNames: string[] = [];
    $('h2.heading span, h3.heading span').each((_, el) => {
      const headingText = $(el).text().trim();
      if (headingText && headingText !== '-' && headingText.toLowerCase().includes('nissan')) {
        // Clean up model name - remove NISSAN prefix and YENİ prefix
        const model = headingText
          .replace(/^(YENİ\s+)?NISSAN\s+/i, '')
          .replace(/\s+YENİ\s+/i, ' ') // Remove "YENİ" from middle
          .trim();
        modelNames.push(model);
      }
    });

    // Collect all tables with price data
    const tables: any[] = [];
    $('table').each((_, table) => {
      const $table = $(table);
      // Check if this table has price data (contains "TL" in cells)
      const hasPrice = $table.text().includes('TL');
      if (hasPrice) {
        tables.push($table);
      }
    });

    // Map tables to model names (they appear in order)
    const modelSections: { model: string; $table: any }[] = [];
    for (let i = 0; i < tables.length; i++) {
      const model = modelNames[i] || 'Unknown';
      modelSections.push({ model, $table: tables[i] });
    }

    // Process each model section
    for (const { model, $table } of modelSections) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      $table.find('tbody tr').each((_: number, row: any) => {
        const $row = $(row);
        const cells = $row.find('td');

        if (cells.length < 2) return;

        // First cell: Version name
        const versionText = $(cells[0]).text().trim();
        if (!versionText || versionText.includes('Versiyon İsmi')) return; // Skip header

        // Second cell: Liste fiyatı (main price)
        const listPriceText = $(cells[1]).text().trim();
        if (!listPriceText) return;

        // Third cell (if exists): Campaign price or turnkey price
        const campaignPriceText = cells.length > 2 ? $(cells[2]).text().trim() : '';

        const priceListNumeric = parsePrice(listPriceText);
        const priceCampaignNumeric = campaignPriceText ? parsePrice(campaignPriceText) : undefined;

        // Use campaign price if valid, otherwise list price
        const priceNumeric = (priceCampaignNumeric && isValidPrice(priceCampaignNumeric))
          ? priceCampaignNumeric
          : priceListNumeric;

        if (!isValidPrice(priceNumeric)) return;

        // Parse version to extract engine, trim, transmission, fuel
        let engine = '';
        let trim = '';
        let transmission = 'Otomatik'; // Default for Nissan
        let fuel = 'Benzin';

        // Extract engine info
        const engineMatch = versionText.match(/(\d+\.\d+\s*(?:DIG-T|ePOWER|e-POWER)?(?:\s*(?:Mild Hybrid|Hybrid)?)?\s*\d+PS)/i);
        if (engineMatch) {
          engine = engineMatch[1].trim();
        } else if (versionText.match(/e-?POWER/i)) {
          const powerMatch = versionText.match(/e-?POWER\s*(\d+PS)/i);
          engine = powerMatch ? `e-POWER ${powerMatch[1]}` : 'e-POWER';
        }

        // Extract trim level
        const trimPatterns = ['Designpack', 'Skypack', 'Platinum Premium', 'Platinum', 'N-Design', 'N-Sport', 'Tekna', 'Acenta', 'Visia'];
        for (const pattern of trimPatterns) {
          if (versionText.toLowerCase().includes(pattern.toLowerCase())) {
            trim = pattern;
            break;
          }
        }
        if (!trim) {
          // Use everything after engine info
          const parts = versionText.split(/\s+(?:Auto|DCT|MT)\s*/i);
          if (parts.length > 1) {
            trim = parts[1].trim();
          } else {
            trim = versionText;
          }
        }

        // Determine fuel type
        if (versionText.match(/e-?POWER/i)) {
          fuel = 'Hybrid'; // e-POWER is series hybrid
        } else if (versionText.match(/Mild Hybrid/i)) {
          fuel = 'Mild Hybrid';
        } else if (versionText.match(/EV|Elektrik/i)) {
          fuel = 'Elektrik';
        } else if (versionText.match(/Dizel|dCi/i)) {
          fuel = 'Dizel';
        }

        // Determine transmission
        if (versionText.match(/\bMT\b|Manuel/i)) {
          transmission = 'Manuel';
        } else if (versionText.match(/\bDCT\b|Auto|Otomatik|CVT/i)) {
          transmission = 'Otomatik';
        }

        // Check for 4x4
        if (versionText.match(/4x4|4WD|AWD/i)) {
          trim += ' 4x4';
        }

        // Determine model from version if not set
        let finalModel = model;
        if (model === 'Unknown') {
          if (versionText.match(/Qashqai/i)) finalModel = 'Qashqai';
          else if (versionText.match(/Juke/i)) finalModel = 'Juke';
          else if (versionText.match(/X-Trail/i)) finalModel = 'X-Trail';
          else if (versionText.match(/Townstar/i)) finalModel = 'Townstar';
          else if (versionText.match(/Navara/i)) finalModel = 'Navara';
          else if (versionText.match(/Micra/i)) finalModel = 'Micra';
        }

        // Check for duplicate
        const exists = vehicles.find(
          v => v.model === finalModel &&
            v.trim === trim &&
            v.engine === engine &&
            v.priceNumeric === priceNumeric
        );

        if (!exists && finalModel && trim) {
          // Get engine details using helper
          const engineDetails = parseNissanEngineDetails(versionText, fuel);

          vehicles.push({
            model: finalModel,
            trim: trim.trim(),
            engine,
            transmission,
            fuel,
            priceRaw: priceNumeric.toLocaleString('tr-TR') + ' TL',
            priceNumeric,
            brand,
            ...(nissanModelYear && { modelYear: nissanModelYear }),
            ...(isValidPrice(priceListNumeric) && { priceListNumeric }),
            ...(priceCampaignNumeric && isValidPrice(priceCampaignNumeric) && { priceCampaignNumeric }),
            // Engine details from helper
            ...(engineDetails.powerHP && { powerHP: engineDetails.powerHP }),
            ...(engineDetails.engineDisplacement && { engineDisplacement: engineDetails.engineDisplacement }),
            ...(engineDetails.engineType && { engineType: engineDetails.engineType }),
            ...(engineDetails.transmissionType && { transmissionType: engineDetails.transmissionType }),
            ...(engineDetails.isHybrid && { isHybrid: engineDetails.isHybrid }),
            ...(engineDetails.isMildHybrid && { isMildHybrid: engineDetails.isMildHybrid }),
            ...(engineDetails.isElectric && { isElectric: engineDetails.isElectric }),
          });
        }
      });
    }
  } catch (error) {
    console.error('Nissan HTML parse error:', error);
  }

  return vehicles;
};

// Honda engine details helper
interface HondaEngineDetails {
  engineDisplacement?: string; // "1.5L", "2.0L"
  engineType?: string;         // "VTEC Turbo"
  isHybrid?: boolean;
  isElectric?: boolean;
}

function parseHondaEngineDetails(engineStr: string, fuelType: string): HondaEngineDetails {
  const details: HondaEngineDetails = {};
  const engineLower = engineStr.toLowerCase();
  const fuelLower = fuelType.toLowerCase();

  // Engine displacement - "1.5L", "2.0L"
  const dispMatch = engineStr.match(/(\d+\.\d+)\s*L/i);
  if (dispMatch) {
    details.engineDisplacement = dispMatch[1] + 'L';
  }

  // Engine type - VTEC Turbo
  if (/VTEC\s*Turbo/i.test(engineStr)) {
    details.engineType = 'VTEC Turbo';
  } else if (/VTEC/i.test(engineStr)) {
    details.engineType = 'VTEC';
  }

  // Hybrid detection
  if (engineLower.includes('hibrit') || engineLower.includes('hybrid') ||
    fuelLower.includes('hibrit') || fuelLower.includes('hybrid')) {
    details.isHybrid = true;
  }

  // Electric detection
  if (engineLower.includes('elektrik') || engineLower.includes('electric') ||
    fuelLower.includes('elektrik') || fuelLower.includes('electric') ||
    /e:ny/i.test(engineStr)) {
    details.isElectric = true;
  }

  return details;
}

// Honda parser - parses HTML data from honda.com.tr
const parseHondaData = (html: string, brand: string): PriceListRow[] => {
  const vehicles: PriceListRow[] = [];

  try {
    const $ = cheerio.load(html);

    // Extract model year from page title/heading
    let hondaModelYear: number | undefined;
    const pageText = $('title').text() + ' ' + $('h1').text() + ' ' + $('h2').text();
    const yearMatch = pageText.match(/\b(202[4-9]|203\d)\b/);
    if (yearMatch) {
      hondaModelYear = parseInt(yearMatch[1], 10);
    }

    // Find all model sections
    $('li.table-price-list').each((_, el) => {
      const id = $(el).attr('id') || '';
      // Extract model name from ID (honda-jazz-hibrit -> Jazz Hibrit)
      // Clean up common patterns
      let model = id
        .replace('honda-', '')
        .replace(/-/g, ' ')
        .split(' ')
        .map(word => {
          // Handle special cases like HR-V, CR-V
          if (word.toLowerCase() === 'hr' || word.toLowerCase() === 'cr' || word.toLowerCase() === 'zr') {
            return word.toUpperCase();
          }
          return word.charAt(0).toUpperCase() + word.slice(1);
        })
        .join(' ')
        .replace(/\s+V\s+/g, '-V ')  // Fix HR V -> HR-V
        .replace(/Hibrit/i, 'Hybrid')
        .trim();

      // Find all engine sections within this model
      const engineEls = $(el).find('.tpl__engine-name');

      engineEls.each((_, engineEl) => {
        const engine = $(engineEl).text().trim();

        // Find the ul.tpl__block that follows this engine
        const $block = $(engineEl).next('ul.tpl__block');

        // Find all tpl__item (trim variants)
        $block.find('.tpl__item').each((_, itemEl) => {
          const $item = $(itemEl);

          // Get trim name
          const trim = $item.find('.tpl__pack-name').text().trim();

          // Get all price spans - first is list price, second (if exists) is campaign price
          const priceSpans = $item.find('.dtl__text span');
          const listPriceText = priceSpans.eq(0).text().trim();
          const campaignPriceText = priceSpans.length > 1 ? priceSpans.eq(1).text().trim() : '';

          const listPriceMatch = listPriceText.match(/(\d{1,2}\.\d{3}\.\d{3})\s*TL/);
          const campaignPriceMatch = campaignPriceText.match(/(\d{1,2}\.\d{3}\.\d{3})\s*TL/);

          if (trim && listPriceMatch) {
            const priceListNumeric = parsePrice(listPriceMatch[0]);
            const priceCampaignNumeric = campaignPriceMatch ? parsePrice(campaignPriceMatch[0]) : undefined;

            // Use campaign price if available, otherwise list price
            const priceNumeric = (priceCampaignNumeric && isValidPrice(priceCampaignNumeric))
              ? priceCampaignNumeric
              : priceListNumeric;

            if (!isValidPrice(priceNumeric)) return;

            // Determine fuel type from engine
            let fuel = 'Benzin';
            if (engine.toLowerCase().includes('hibrit') || engine.toLowerCase().includes('hybrid')) {
              fuel = 'Hibrit';
            } else if (engine.toLowerCase().includes('dizel') || engine.toLowerCase().includes('diesel')) {
              fuel = 'Dizel';
            } else if (engine.toLowerCase().includes('elektrik') || engine.toLowerCase().includes('ev')) {
              fuel = 'Elektrik';
            }

            // Determine transmission from engine
            let transmission = 'Otomatik';
            if (engine.toLowerCase().includes('manuel') || engine.toLowerCase().includes('manual')) {
              transmission = 'Manuel';
            }

            // Check for duplicate
            const exists = vehicles.find(
              v => v.model === model &&
                v.trim === trim &&
                v.engine === engine &&
                v.priceNumeric === priceNumeric
            );

            if (!exists) {
              // Get engine details using helper
              const engineDetails = parseHondaEngineDetails(engine, fuel);

              vehicles.push({
                model,
                trim,
                engine,
                transmission,
                fuel,
                priceRaw: priceNumeric.toLocaleString('tr-TR') + ' TL',
                priceNumeric,
                brand,
                ...(hondaModelYear && { modelYear: hondaModelYear }),
                ...(isValidPrice(priceListNumeric) && { priceListNumeric }),
                ...(priceCampaignNumeric && isValidPrice(priceCampaignNumeric) && { priceCampaignNumeric }),
                // Extended fields from engine details
                ...(engineDetails.engineDisplacement && { engineDisplacement: engineDetails.engineDisplacement }),
                ...(engineDetails.engineType && { engineType: engineDetails.engineType }),
                ...(engineDetails.isHybrid && { isHybrid: engineDetails.isHybrid }),
                ...(engineDetails.isElectric && { isElectric: engineDetails.isElectric }),
              });
            }
          }
        });
      });
    });
  } catch (error) {
    console.error('Honda HTML parse error:', error);
  }

  return vehicles;
};

// SEAT engine details helper
interface SeatEngineDetails {
  powerHP?: number;
  engineDisplacement?: string;  // "1.0L", "1.5L"
  engineType?: string;          // "EcoTSI", "eHybrid", "EcoTSI ACT"
  transmissionType?: string;    // "DSG"
  isHybrid?: boolean;
  isPlugInHybrid?: boolean;
}

function parseSeatEngineDetails(engineStr: string, transmissionStr: string): SeatEngineDetails {
  const details: SeatEngineDetails = {};

  // Power HP - "115 PS", "150 PS", "204 PS"
  const hpMatch = engineStr.match(/(\d{2,3})\s*PS/i);
  if (hpMatch) {
    details.powerHP = parseInt(hpMatch[1], 10);
  }

  // Engine displacement - "1.0", "1.5"
  const dispMatch = engineStr.match(/^(\d+\.\d+)/);
  if (dispMatch) {
    details.engineDisplacement = dispMatch[1] + 'L';
  }

  // Engine type - "EcoTSI", "eHybrid", "EcoTSI ACT", "TDI"
  // Must extract between displacement and PS
  const typeMatch = engineStr.match(/^\d+\.\d+\s+(.+?)\s+\d+\s*PS/i);
  if (typeMatch) {
    details.engineType = typeMatch[1].trim();
  }

  // Transmission type from transmission string
  if (transmissionStr.includes('DSG')) {
    details.transmissionType = 'DSG';
  }

  // Hybrid detection - eHybrid is plug-in hybrid
  if (/eHybrid/i.test(engineStr)) {
    details.isHybrid = true;
    details.isPlugInHybrid = true;
  }

  return details;
}

// SEAT parser - parses HTML data from seat.com.tr
const parseSeatData = (html: string, brand: string): PriceListRow[] => {
  const vehicles: PriceListRow[] = [];

  try {
    const $ = cheerio.load(html);

    // Find all table rows with model data
    // Try to extract model year from page (title, heading, or data attribute)
    let seatModelYear: number | undefined;
    const pageTitle = $('title').text() + ' ' + $('h1, h2').first().text();
    const seatYearMatch = pageTitle.match(/\b(202[4-9]|203\d)\b/);
    if (seatYearMatch) {
      seatModelYear = parseInt(seatYearMatch[1], 10);
    }

    $('.table-row-container .table-row').each((_, row) => {
      const $row = $(row);

      // Get model name (e.g., "Ibiza 1.0 EcoTSI 115 PS DSG Style")
      const modelName = $row.find('.model-name').text().trim();
      if (!modelName) return;

      // Check for per-row model year element
      const rowYearText = $row.find('.model-year, .year').text().trim();
      const rowYear = rowYearText.match(/\b(202[4-9]|203\d)\b/);
      const seatRowYear = rowYear ? parseInt(rowYear[1], 10) : seatModelYear;

      // Get fuel type (e.g., "Benzinli", "Hibrit")
      let fuel = $row.find('.model-details').text().trim() || 'Benzin';
      // Normalize fuel type
      if (fuel.toLowerCase().includes('hibrit') || fuel.toLowerCase().includes('hybrid')) {
        fuel = 'Hibrit';
      } else if (fuel.toLowerCase().includes('dizel') || fuel.toLowerCase().includes('diesel')) {
        fuel = 'Dizel';
      } else if (fuel.toLowerCase().includes('elektrik') || fuel.toLowerCase().includes('electric')) {
        fuel = 'Elektrik';
      } else {
        fuel = 'Benzin';
      }

      // Get prices - page may have 1 (turnkey only) or 2 (list + turnkey)
      const $prices = $row.find('.price');
      if ($prices.length < 1) return;

      let priceText: string;
      let listPriceText: string | undefined;

      if ($prices.length >= 2) {
        // Old format: list price + turnkey price
        listPriceText = $($prices[0]).text().trim();
        priceText = $($prices[1]).text().trim();
      } else {
        // New format: only turnkey price
        priceText = $($prices[0]).text().trim();
      }

      const priceMatch = priceText.match(/(\d{1,3}(?:\.\d{3})+)/);
      if (!priceMatch) return;

      const priceNumeric = parsePrice(priceMatch[0] + ' TL');
      if (!isValidPrice(priceNumeric)) return;

      const listPriceMatch = listPriceText?.match(/(\d{1,3}(?:\.\d{3})+)/);
      const priceListNumeric = listPriceMatch ? parsePrice(listPriceMatch[0] + ' TL') : undefined;

      // Parse model name to extract components
      // Example: "Ibiza 1.0 EcoTSI 115 PS DSG Style" or "YENİ IBIZA 1.0 TSI 116 PS DSG Style Plus"
      // Strip a leading marketing prefix ("YENİ"/"YENI"/"NEW") so the badge isn't
      // captured as the model, and normalize casing (LEON -> Leon) so duplicates merge.
      // ([iİ] is explicit because the JS /i flag does not fold the Turkish dotted İ.)
      const cleanedName = modelName.replace(/^\s*(yen[iİ]|new)\s+/i, '').trim();
      const rawModel = cleanedName.split(/\s+/)[0] || '';
      const model = rawModel.charAt(0).toUpperCase() + rawModel.slice(1).toLowerCase(); // Ibiza, Arona, Leon, Ateca

      // Find engine and power info
      let engine = '';
      let trim = '';
      let transmission = 'Manuel';

      // Find engine spec (e.g., "1.0 EcoTSI 115 PS" or "1.5 eHybrid 204 PS" or "1.5 EcoTSI ACT 150 PS")
      const engineMatch = cleanedName.match(/(\d+\.\d+)\s+([\w-]+(?:\s+[\w-]+)?)\s+(\d+)\s*PS/i);
      if (engineMatch) {
        engine = `${engineMatch[1]} ${engineMatch[2]} ${engineMatch[3]} PS`;
      }

      // Check for transmission
      if (cleanedName.includes('DSG')) {
        transmission = 'Otomatik (DSG)';
      } else if (cleanedName.match(/\bAT\b|Otomatik/i)) {
        transmission = 'Otomatik';
      }

      // Extract trim (everything after PS and transmission)
      const trimMatch = cleanedName.match(/PS\s+(?:DSG\s+)?(.+?)(?:'[^']+')?$/i);
      if (trimMatch) {
        trim = trimMatch[1].replace(/DSG\s*/i, '').trim();
        // Handle Dark Edition or other quoted suffixes
        const quotedMatch = cleanedName.match(/'([^']+)'/);
        if (quotedMatch) {
          trim += ' ' + quotedMatch[1];
        }
      }

      // Check for duplicate
      const exists = vehicles.find(
        v => v.model === model &&
          v.trim === trim &&
          v.engine === engine &&
          v.priceNumeric === priceNumeric
      );

      if (!exists && model && trim) {
        // Get engine details using helper
        const engineDetails = parseSeatEngineDetails(engine, transmission);

        vehicles.push({
          model,
          trim: trim.trim(),
          engine,
          transmission,
          fuel,
          priceRaw: priceNumeric.toLocaleString('tr-TR') + ' TL',
          priceNumeric,
          brand,
          ...(seatRowYear && { modelYear: seatRowYear }),
          ...(priceListNumeric && isValidPrice(priceListNumeric) && { priceListNumeric }),
          // Extended fields from engine details
          ...(engineDetails.powerHP && { powerHP: engineDetails.powerHP }),
          ...(engineDetails.engineDisplacement && { engineDisplacement: engineDetails.engineDisplacement }),
          ...(engineDetails.engineType && { engineType: engineDetails.engineType }),
          ...(engineDetails.transmissionType && { transmissionType: engineDetails.transmissionType }),
          ...(engineDetails.isHybrid && { isHybrid: engineDetails.isHybrid }),
          ...(engineDetails.isPlugInHybrid && { isPlugInHybrid: engineDetails.isPlugInHybrid }),
        });
      }
    });
  } catch (error) {
    console.error('SEAT HTML parse error:', error);
  }

  return vehicles;
};

// Kia parser - Extract data from embedded JavaScript objects
const parseKiaData = (html: string, brand: string): PriceListRow[] => {
  const vehicles: PriceListRow[] = [];

  try {
    // Kia uses AngularJS with data embedded in JavaScript objects
    // Pattern: var item = { 'modelName' : "EV3", 'trimDisplayName' : "Elegance", 'turnkeyPrice' : " 2.095.000", ... }

    // Extract all item objects from the HTML
    const itemPattern = /var\s+item\s*=\s*\{([^}]+)\}/g;
    let match;

    while ((match = itemPattern.exec(html)) !== null) {
      const itemContent = match[1];

      // Extract fields from the item object
      const extractField = (fieldName: string): string => {
        const regex = new RegExp(`['"]${fieldName}['"]\\s*:\\s*['"]([^'"]*)['"\\s]`, 'i');
        const fieldMatch = itemContent.match(regex);
        return fieldMatch ? fieldMatch[1].trim() : '';
      };

      const modelName = extractField('modelName') || extractField('modelDisplayName');
      const trimName = extractField('trimDisplayName');
      const priceStr = extractField('turnkeyPrice');
      const listPriceStr = extractField('listPrice') || extractField('suggestedPrice') || extractField('basePrice');
      const fuel = extractField('fuelDisplayName');
      const transmission = extractField('transmissionDisplayName');
      const power = extractField('moterPower');
      const powerUnit = extractField('moterPowerUnit') || 'PS';
      const engineCapacity = extractField('engineCapacity');

      if (!modelName || !priceStr) continue;

      // Parse price
      const priceNumeric = parsePrice(priceStr + ' TL');
      if (!isValidPrice(priceNumeric)) continue;

      // Build engine string
      let engine = '';
      if (engineCapacity) {
        engine = `${engineCapacity} cc`;
      }
      if (power) {
        engine += engine ? ` ${power} ${powerUnit}` : `${power} ${powerUnit}`;
      }

      // Normalize fuel type
      let normalizedFuel = 'Benzin';
      if (fuel) {
        const fuelLower = fuel.toLowerCase();
        if (fuelLower.includes('elektrik') || fuelLower.includes('electric')) {
          normalizedFuel = 'Elektrik';
        } else if (fuelLower.includes('hibrit') || fuelLower.includes('hybrid')) {
          normalizedFuel = 'Hibrit';
        } else if (fuelLower.includes('dizel') || fuelLower.includes('diesel')) {
          normalizedFuel = 'Dizel';
        } else if (fuelLower.includes('benzin') || fuelLower.includes('petrol')) {
          normalizedFuel = 'Benzin';
        }
      }

      // Normalize transmission
      let normalizedTransmission = 'Manuel';
      if (transmission) {
        const transLower = transmission.toLowerCase();
        if (transLower.includes('otomatik') || transLower.includes('dct') || transLower.includes('at') || transLower.includes('auto')) {
          normalizedTransmission = 'Otomatik';
        }
      }

      // Check for duplicate
      const exists = vehicles.find(
        v => v.model === modelName &&
          v.trim === trimName &&
          v.priceNumeric === priceNumeric
      );

      if (!exists && trimName) {
        // Extract additional fields
        const campaignPriceStr = extractField('campaignPrice');
        const retailPriceStr = extractField('retailPrice');
        const sctStr = extractField('sct');
        const tabYear = extractField('tabYear');
        const engineName = extractField('engineName');

        // Parse list price (retail price has priority, then fallback to listPrice)
        const priceListNumeric = retailPriceStr ? parsePrice(retailPriceStr + ' TL') :
          listPriceStr ? parsePrice(listPriceStr + ' TL') : undefined;

        // Parse campaign price
        const priceCampaignNumeric = campaignPriceStr ? parsePrice(campaignPriceStr + ' TL') : undefined;

        // Parse OTV rate - validate range (Turkish OTV max is ~220%, reject values > 300)
        const rawSct = sctStr && !isNaN(parseInt(sctStr, 10)) ? parseInt(sctStr, 10) : undefined;
        const otvRate = rawSct && rawSct > 0 && rawSct <= 300 ? rawSct : undefined;

        // Parse model year
        const modelYear = tabYear && !isNaN(parseInt(tabYear, 10)) ? parseInt(tabYear, 10) : undefined;

        // Parse engine displacement from engineName (e.g., "1.5L", "1.0L")
        let engineDisplacement: string | undefined;
        if (engineName && engineName.match(/^\d+\.\d+L?$/i)) {
          engineDisplacement = engineName.includes('L') ? engineName : engineName + 'L';
        }

        // Determine power field based on unit (HP vs kW)
        let powerHP: number | undefined;
        let powerKW: number | undefined;
        if (power && !isNaN(parseInt(power, 10))) {
          const powerNum = parseInt(power, 10);
          if (powerUnit.toLowerCase() === 'kw') {
            powerKW = powerNum;
          } else {
            powerHP = powerNum;
          }
        }

        // Extract transmission type from transmissionDisplayName
        let transmissionType: string | undefined;
        if (transmission) {
          if (transmission.includes('DCT')) {
            transmissionType = 'DCT';
          } else if (transmission.toLowerCase().includes('at') || transmission.includes('Otomatik')) {
            transmissionType = 'AT';
          }
        }

        // Detect hybrid/electric
        const isHybrid = normalizedFuel === 'Hibrit';
        const isElectric = normalizedFuel === 'Elektrik';

        vehicles.push({
          model: modelName,
          trim: trimName,
          engine: engine || '-',
          transmission: normalizedTransmission,
          fuel: normalizedFuel,
          priceRaw: priceNumeric.toLocaleString('tr-TR') + ' TL',
          priceNumeric,
          brand,
          ...(priceListNumeric && isValidPrice(priceListNumeric) && { priceListNumeric }),
          ...(priceCampaignNumeric && isValidPrice(priceCampaignNumeric) && { priceCampaignNumeric }),
          // Extended fields
          ...(powerHP && { powerHP }),
          ...(powerKW && { powerKW }),
          ...(engineDisplacement && { engineDisplacement }),
          ...(transmissionType && { transmissionType }),
          ...(modelYear && { modelYear }),
          ...(otvRate && { otvRate }),
          ...(isHybrid && { isHybrid }),
          ...(isElectric && { isElectric }),
        });
      }
    }
  } catch (error) {
    console.error('Kia HTML parse error:', error);
  }

  return vehicles;
};

// Volvo engine details parser
interface VolvoEngineDetails {
  powerKW?: number;           // 150, 315, 300
  powerHP?: number;           // 204, 428, 408, 197, 250
  engineDisplacement?: string; // "2.0L"
}

function parseVolvoEngineDetails(engineStr: string): VolvoEngineDetails {
  const details: VolvoEngineDetails = {};

  // Power from "150 kW / 204 hp" pattern (electric)
  const kwHpMatch = engineStr.match(/(\d+)\s*kW\s*\/\s*(\d+)\s*hp/i);
  if (kwHpMatch) {
    details.powerKW = parseInt(kwHpMatch[1], 10);
    details.powerHP = parseInt(kwHpMatch[2], 10);
  } else {
    // Power from "197 hp" pattern only (ICE)
    const hpMatch = engineStr.match(/(\d+)\s*hp/i);
    if (hpMatch) {
      details.powerHP = parseInt(hpMatch[1], 10);
    }
  }

  // Engine displacement from "1.969 cc" → "2.0L"
  // Note: Volvo uses "1.969 cc" format meaning 1.969 liters (1969 cc)
  const ccMatch = engineStr.match(/(\d[\d.]+)\s*cc/i);
  if (ccMatch) {
    const liters = parseFloat(ccMatch[1]); // Already in liters (1.969 = 1969cc)
    // Round to nearest 0.1L
    const rounded = Math.round(liters * 10) / 10;
    details.engineDisplacement = rounded.toFixed(1) + 'L';
  }

  return details;
}

// Volvo trim details parser
interface VolvoTrimDetails {
  driveType?: string;         // "RWD", "AWD", "FWD"
  hasLongRange?: boolean;     // EXTENDED RANGE
  isMildHybrid?: boolean;     // MILD HYBRID
  isPlugInHybrid?: boolean;   // PLUG-IN HYBRID
}

function parseVolvoTrimDetails(trimStr: string, modelStr: string): VolvoTrimDetails {
  const details: VolvoTrimDetails = {};
  const combined = (trimStr + ' ' + modelStr).toUpperCase();

  // Drive type detection
  if (combined.includes('SINGLE MOTOR')) {
    details.driveType = 'RWD'; // Rear-wheel drive (single motor is rear)
  } else if (combined.includes('TWIN MOTOR')) {
    details.driveType = 'AWD'; // All-wheel drive (dual motor)
  } else if (combined.includes('AWD')) {
    details.driveType = 'AWD';
  } else if (combined.includes('FWD')) {
    details.driveType = 'FWD';
  }

  // Extended range (long range battery)
  if (combined.includes('EXTENDED RANGE')) {
    details.hasLongRange = true;
  }

  // Mild hybrid (48V system)
  if (combined.includes('MILD HYBRID')) {
    details.isMildHybrid = true;
  }

  // Plug-in hybrid
  if (combined.includes('PLUG-IN HYBRID') || combined.includes('PLUG-IN-HYBRID')) {
    details.isPlugInHybrid = true;
  }

  return details;
}

// Volvo parser - parses PDF data (PDF extracted via pdf.js-extract)
const parseVolvoData = (pdfResult: PDFExtractResult, brand: string): PriceListRow[] => {
  const vehicles: PriceListRow[] = [];

  try {
    // Volvo PDF has a single page with all models
    // Row structure: specs row (Y) followed by model name row (Y+2)
    // Specs: Fuel | Engine | Power | Transmission | prices... | Final Price
    // Model: "MODEL, TRIM, VARIANT"

    const page = pdfResult.pages[0];
    if (!page) return vehicles;

    // Try to extract model year from PDF header
    let volvoPdfYear: number | undefined;
    const allText = page.content.map((i: any) => i.str).join(' ');
    const volvoYearMatch = allText.match(/\b(202[4-9]|203\d)\b/);
    if (volvoYearMatch) {
      volvoPdfYear = parseInt(volvoYearMatch[1], 10);
    }

    // Group content by Y position (rounded)
    const rows: { [y: number]: { x: number; str: string }[] } = {};
    page.content.forEach(item => {
      const y = Math.round(item.y);
      if (!rows[y]) rows[y] = [];
      rows[y].push({ x: item.x, str: item.str });
    });

    // Sort rows by Y (top to bottom)
    const sortedYs = Object.keys(rows).map(Number).sort((a, b) => a - b);

    // As of the MY27 list each vehicle is ONE row (previously specs + model were on
    // two separate rows). Columns, left to right:
    //   "MODEL, TRIM" | FUEL | DISPLACEMENT | POWER | TRANSMISSION |
    //   net price | ÖTV% | ÖTV-incl | KDV-incl | registration | TURNKEY (last)
    const fuelKeywords = ['Elektrik/Benzin', 'Elektrik', 'Benzin', 'Dizel'];

    for (const y of sortedYs) {
      const cells = rows[y].sort((a, b) => a.x - b.x).map(c => c.str.trim()).filter(Boolean);
      if (cells.length === 0) continue;

      // A data row starts with a Volvo model code (EX30, EX40, EC40, XC60, V60, S90...).
      // This also excludes header/footer/legal rows without relying on Y thresholds.
      if (!/^(EX|EC|XC|V|S|C)\d{2}\b/i.test(cells[0])) continue;

      // The fuel cell separates "MODEL, TRIM" (before it) from the spec/price columns.
      let fuelIdx = -1;
      let fuelVal = '';
      for (let k = 0; k < cells.length; k++) {
        const match = fuelKeywords.find(fk => cells[k] === fk || cells[k].startsWith(fk));
        if (match) { fuelIdx = k; fuelVal = match; break; }
      }

      const modelTrim = (fuelIdx > 0 ? cells.slice(0, fuelIdx) : [cells[0]])
        .join(' ').replace(/\s+/g, ' ').trim();
      const rowText = cells.join(' ');

      // Model = vehicle code (first token); trim = the remainder (drop a leading comma).
      const model = modelTrim.split(/\s+/)[0];
      const trim = modelTrim.slice(model.length).replace(/^[\s,]+/, '').trim();

      // Fuel: the fuel column reads "Benzin" even for mild hybrids, so consult the trim.
      let fuel: string;
      if (fuelVal === 'Elektrik/Benzin' || /plug-in hybrid/i.test(modelTrim)) {
        fuel = 'Plug-in Hibrit';
      } else if (/mild hybrid|hibrit|hybrid/i.test(modelTrim)) {
        fuel = 'Hibrit';
      } else if (fuelVal === 'Elektrik') {
        fuel = 'Elektrik';
      } else if (fuelVal === 'Dizel') {
        fuel = 'Dizel';
      } else {
        fuel = 'Benzin';
      }

      // Engine = displacement ("1.969 cc.") + power ("150kW/204hp" or "250 hp"/"250+156 hp").
      let engine = '';
      const powerMatch = rowText.match(/(\d+)\s*kW\s*\/\s*(\d+)\s*hp/i) || rowText.match(/(\d+(?:\+\d+)?)\s*hp/i);
      if (powerMatch) {
        engine = powerMatch[2] ? `${powerMatch[1]} kW / ${powerMatch[2]} hp` : `${powerMatch[1]} hp`;
      }
      const ccMatch = rowText.match(/(\d[.,]\d{3})\s*cc/i);
      if (ccMatch) engine = `${ccMatch[1]} cc ${engine}`.trim();

      let transmission = 'Otomatik';
      if (/manuel/i.test(rowText)) transmission = 'Manuel';

      // Prices: strip the displacement first (it looks like a price, e.g. "1.969 cc"),
      // then the LAST money token is the turnkey price (TAVSİYE EDİLEN ANAHTAR TESLİM).
      const priceText = rowText.replace(/\d[\d.,]*\s*cc\.?/gi, ' ');
      const priceTokens = priceText.match(/\d{1,3}(?:\.\d{3})+/g) || [];
      const prices = priceTokens.map(p => parsePrice(p + ' TL')).filter(p => isValidPrice(p));
      if (prices.length === 0) continue;
      const priceNumeric = prices[prices.length - 1];

      // ÖTV rate (e.g. "55%").
      const otvMatch = rowText.match(/(\d{1,3})\s*%/);
      const otvRate = otvMatch ? parseInt(otvMatch[1], 10) : undefined;

      // Skip duplicates (e.g. Bright/Dark variants that resolve to the same row).
      if (vehicles.find(v => v.model === model && v.trim === trim && v.priceNumeric === priceNumeric)) continue;

      const engineDetails = parseVolvoEngineDetails(engine);
      const trimDetails = parseVolvoTrimDetails(trim, model);
      const isElectric = fuel === 'Elektrik';
      const isHybrid = fuel === 'Hibrit';

      vehicles.push({
        model,
        trim,
        engine: engine || '-',
        transmission,
        fuel,
        priceRaw: priceNumeric.toLocaleString('tr-TR') + ' TL',
        priceNumeric,
        brand,
        ...(volvoPdfYear && { modelYear: volvoPdfYear }),
        ...(otvRate !== undefined && { otvRate }),
        // Extended fields - engine
        ...(engineDetails.powerKW && { powerKW: engineDetails.powerKW }),
        ...(engineDetails.powerHP && { powerHP: engineDetails.powerHP }),
        ...(engineDetails.engineDisplacement && { engineDisplacement: engineDetails.engineDisplacement }),
        // Extended fields - trim
        ...(trimDetails.driveType && { driveType: trimDetails.driveType }),
        ...(trimDetails.hasLongRange && { hasLongRange: trimDetails.hasLongRange }),
        ...(trimDetails.isMildHybrid && { isMildHybrid: trimDetails.isMildHybrid }),
        ...(trimDetails.isPlugInHybrid && { isPlugInHybrid: trimDetails.isPlugInHybrid }),
        // Extended fields - fuel type flags
        ...(isElectric && { isElectric }),
        ...(isHybrid && { isHybrid }),
      });
    }
  } catch (error) {
    console.error('Volvo PDF parse error:', error);
  }

  return vehicles;
};

// Citroen engine details parser
interface CitroenEngineDetails {
  powerHP?: number;           // 110, 130, 145
  powerKW?: number;           // 83, 100, 136
  engineDisplacement?: string; // "1.2L", "1.5L", "1.6L"
  engineType?: string;        // "PureTech", "BlueHDi", "Hybrid"
  transmissionType?: string;  // "EAT8", "eDCS6", "MT6"
  isElectric?: boolean;
  isHybrid?: boolean;
  hasLongRange?: boolean;     // Uzun Menzil (long range battery)
}

function parseCitroenEngineDetails(engine: string, model: string): CitroenEngineDetails {
  const details: CitroenEngineDetails = {};

  // Power kW (electric vehicles) - "83 kW", "6 kW Elektrik Motor"
  const kwMatch = engine.match(/(\d+)\s*kW/i);
  if (kwMatch) {
    details.powerKW = parseInt(kwMatch[1], 10);
    details.isElectric = true;
  }

  // Power HP - "145*", "130", "110" (with optional asterisk, typically 2-3 digits followed by * or space/dash)
  // Match patterns like "Hybrid 145*", "PureTech 130", "BlueHDi 100"
  const hpMatch = engine.match(/(?:Hybrid|PureTech|BlueHDi)\s+(\d{2,3})\*?/i);
  if (hpMatch && !details.powerKW) {
    details.powerHP = parseInt(hpMatch[1], 10);
  }

  // Engine displacement - "1.2", "1.5", "1.6", "2.0"
  const dispMatch = engine.match(/(\d+\.\d+)\s+/);
  if (dispMatch) {
    details.engineDisplacement = dispMatch[1] + 'L';
  }

  // Engine type - PureTech, BlueHDi, Hybrid
  if (/PureTech/i.test(engine)) {
    details.engineType = 'PureTech';
  } else if (/BlueHDi/i.test(engine)) {
    details.engineType = 'BlueHDi';
  } else if (/Hybrid/i.test(engine)) {
    details.engineType = 'Hybrid';
    details.isHybrid = true;
  }

  // Transmission type - EAT8, eDCS6, MT6, etc.
  const transMatch = engine.match(/(EAT\d|eDCS\d|MT\d)/i);
  if (transMatch) {
    details.transmissionType = transMatch[1].toUpperCase();
  }

  // Hybrid detection from model name
  if (/Hybrid/i.test(model) && !details.isHybrid) {
    details.isHybrid = true;
  }

  // Electric detection from model name (ë- prefix or "elektrik")
  if (/ë-|elektrik/i.test(model) && !details.isElectric) {
    details.isElectric = true;
  }

  // Long range detection (Uzun Menzil)
  if (/Uzun\s*Menzil/i.test(engine)) {
    details.hasLongRange = true;
  }

  return details;
}

// Citroen parser - parses JSON data from talep.citroen.com.tr
const parseCitroenData = (data: any, brand: string): PriceListRow[] => {
  const vehicles: PriceListRow[] = [];

  try {
    // Get all prices from the first (and usually only) price data entry
    const pricesAll = data?.pageProps?.pricesAll;
    if (!Array.isArray(pricesAll) || pricesAll.length === 0) {
      console.log('    Warning: No pricesAll array found');
      return vehicles;
    }

    // Try to extract model year from pricesAll entry attributes or title
    let citroenModelYear: number | undefined;
    const firstEntry = pricesAll[0]?.attributes;
    if (firstEntry) {
      // Check common year fields in attributes
      const yearCandidate = firstEntry.Year || firstEntry.year || firstEntry.ModelYear || firstEntry.modelYear;
      if (yearCandidate && !isNaN(parseInt(String(yearCandidate), 10))) {
        citroenModelYear = parseInt(String(yearCandidate), 10);
      }
      // Try to extract from Title/Name (e.g., "Fiyat Listesi 2026")
      if (!citroenModelYear) {
        const titleStr = firstEntry.Title || firstEntry.Name || '';
        const yearMatch = String(titleStr).match(/\b(202[4-9]|203\d)\b/);
        if (yearMatch) {
          citroenModelYear = parseInt(yearMatch[1], 10);
        }
      }
    }

    // Get the models mapping for display names
    const models = data?.pageProps?.models || [];
    const modelMap: { [key: string]: string } = {};
    models.forEach((model: any) => {
      const code = model?.attributes?.Name || model?.attributes?.ModelCode;
      const displayName = model?.attributes?.DisplayName || model?.attributes?.ModelName;
      if (code && displayName) {
        modelMap[code.toLowerCase()] = displayName;
      }
    });

    // Get prices from the first entry (most recent)
    const priceData = pricesAll[0]?.attributes?.Data?.prices;
    if (!Array.isArray(priceData)) {
      console.log('    Warning: No prices array found in Data');
      return vehicles;
    }

    for (const item of priceData) {
      const modelCode = item.model || '';
      const motor1 = item.motor1 || '';
      const motor2 = item.motor2 || '';
      const donanim = item.donanim || '';
      const listPrice = item.list_price || '';
      const campaignPrice = item.campaign_price || '';
      // Per-item model year (if present in data)
      const itemYear = item.model_year || item.modelYear || item.year;

      // Use campaign price if available, otherwise list price
      const priceStr = campaignPrice || listPrice;
      if (!priceStr) continue;

      const priceNumeric = parsePrice(priceStr);
      if (!isValidPrice(priceNumeric)) continue;

      // Get display model name from mapping or clean up the code
      let modelName = modelMap[modelCode.toLowerCase()];
      if (!modelName) {
        // Clean up model code: yeni-ec3 -> Yeni E-C3, yeni-c3-aircross-suv -> Yeni C3 Aircross SUV
        modelName = modelCode
          .replace(/-/g, ' ')
          .replace(/\b(ec3|e c3)\b/gi, 'E-C3')
          .replace(/\b(c3|c4|c5)\b/gi, (m: string) => m.toUpperCase())
          .split(' ')
          .map((word: string) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
          .join(' ')
          .replace(/E C3/g, 'E-C3')
          .replace(/C3 Aircross/g, 'C3 Aircross')
          .trim();
      }

      // Combine motor info
      let engine = motor1;
      if (motor2) {
        engine = `${motor1} ${motor2}`.trim();
      }
      // Also check the "motor" field
      if (!engine && item.motor) {
        engine = item.motor.trim();
      }

      // Determine fuel type
      let fuel = '';
      const engineLower = engine.toLowerCase();
      const modelLower = modelName.toLowerCase();
      if (engineLower.includes('kw') || modelLower.includes('elektrik') || modelLower.includes('e-c3') || modelLower.includes('ami')) {
        fuel = 'Elektrik';
      } else if (engineLower.includes('hybrid')) {
        fuel = 'Hybrid';
      } else if (engineLower.includes('bluehdi') || engineLower.includes('dizel')) {
        fuel = 'Dizel';
      } else if (engineLower.includes('puretech') || engine) {
        fuel = 'Benzin';
      }

      // Determine transmission
      let transmission = '';
      const engineTransCheck = `${engine} ${motor2}`.toLowerCase();
      if (engineTransCheck.includes('edcs') || engineTransCheck.includes('eat') || engineTransCheck.includes('otomatik')) {
        transmission = 'Otomatik';
      } else if (engineTransCheck.includes('mt') || engineTransCheck.includes('manuel')) {
        transmission = 'Manuel';
      } else if (fuel === 'Elektrik') {
        // Electric cars are typically automatic
        transmission = 'Otomatik';
      }

      // Check for duplicate (include transmission & fuel to catch all variants)
      const exists = vehicles.find(
        v => v.model === modelName &&
          v.trim === donanim &&
          v.engine === engine &&
          v.transmission === transmission &&
          v.fuel === fuel &&
          v.priceNumeric === priceNumeric
      );

      if (!exists) {
        // Parse list and campaign prices separately
        const priceListNum = listPrice ? parsePrice(listPrice) : undefined;
        const priceCampaignNum = campaignPrice ? parsePrice(campaignPrice) : undefined;

        // Parse engine details using helper
        const engineDetails = parseCitroenEngineDetails(engine, modelName);

        // Determine vehicle category (commercial vs passenger)
        const isCommercial = /Van|Berlingo|Spacetourer/i.test(modelName);

        // Use per-item year if available, otherwise global PDF/page year
        const resolvedItemYear = itemYear && !isNaN(parseInt(String(itemYear), 10))
          ? parseInt(String(itemYear), 10)
          : citroenModelYear;

        vehicles.push({
          model: modelName,
          trim: donanim,
          engine,
          transmission,
          fuel,
          priceRaw: priceNumeric.toLocaleString('tr-TR') + ' TL',
          priceNumeric,
          brand,
          ...(resolvedItemYear && { modelYear: resolvedItemYear }),
          ...(priceListNum && isValidPrice(priceListNum) && { priceListNumeric: priceListNum }),
          ...(priceCampaignNum && isValidPrice(priceCampaignNum) && { priceCampaignNumeric: priceCampaignNum }),
          // Engine/Power fields
          ...(engineDetails.powerHP && { powerHP: engineDetails.powerHP }),
          ...(engineDetails.powerKW && { powerKW: engineDetails.powerKW }),
          ...(engineDetails.engineDisplacement && { engineDisplacement: engineDetails.engineDisplacement }),
          ...(engineDetails.engineType && { engineType: engineDetails.engineType }),
          ...(engineDetails.transmissionType && { transmissionType: engineDetails.transmissionType }),
          ...(engineDetails.isElectric && { isElectric: engineDetails.isElectric }),
          ...(engineDetails.isHybrid && { isHybrid: engineDetails.isHybrid }),
          ...(engineDetails.hasLongRange && { hasLongRange: engineDetails.hasLongRange }),
          // Vehicle category
          ...(isCommercial && { vehicleCategory: 'Ticari' }),
        });
      }
    }
  } catch (error) {
    console.error('Citroen parse error:', error);
  }

  return vehicles;
};

// Parse data based on brand parser type
const parseData = (data: any, brand: string, parserType: string, modelName?: string): PriceListRow[] => {
  switch (parserType) {
    case 'vw': return parseVWData(data, brand);
    case 'skoda': return parseSkodaData(data, brand);
    case 'renault': return parseRenaultData(data, brand);
    case 'toyota': return parseToyotaData(data, brand);
    case 'hyundai': return parseHyundaiData(data, brand);
    case 'fiat': return parseFiatData(data, brand);
    case 'peugeot': return parsePeugeotData(data, brand);
    case 'byd': return parseBYDData(data, brand);
    case 'opel': return parseOpelData(data, brand, modelName);
    case 'citroen': return parseCitroenData(data, brand);
    case 'bmw': return parseBMWData(data, brand);
    case 'mercedes': return parseMercedesData(data, brand);
    case 'ford': return parseFordData(data, brand);
    case 'nissan': return parseNissanData(data, brand);
    case 'honda': return parseHondaData(data, brand);
    case 'seat': return parseSeatData(data, brand);
    case 'kia': return parseKiaData(data, brand);
    case 'volvo': return parseVolvoData(data, brand);
    default: return [];
  }
};

// Fetch data from a single URL (with 30s timeout to prevent CI hangs)
async function fetchSingleUrl(url: string, responseType?: string): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  const response = await fetch(url, {
    signal: controller.signal,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, application/xml, text/xml, text/plain, application/pdf, text/html, */*',
      'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  }).finally(() => clearTimeout(timeout));

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  if (responseType === 'xml') {
    const xmlText = await response.text();
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '',
    });
    return parser.parse(xmlText);
  }

  if (responseType === 'pdf') {
    // Download PDF to temp file and extract with pdf.js-extract
    const tempPath = path.join('/tmp', `pdf-temp-${Date.now()}.pdf`);
    const buffer = await response.arrayBuffer();
    fs.writeFileSync(tempPath, Buffer.from(buffer));

    const pdfExtract = new PDFExtract();
    const pdfData = await promiseWithTimeout(pdfExtract.extract(tempPath, {}), 60_000, 'PDF extract (fetchSingleUrl)');

    // Clean up temp file
    try { fs.unlinkSync(tempPath); } catch { }

    return pdfData;
  }

  if (responseType === 'html') {
    return response.text();
  }

  return response.json();
}

// Fetch Ford API with special headers
async function fetchFordUrl(url: string): Promise<any> {
  const response = await fetchWithTimeout(url, {
    headers: {
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'tr,en;q=0.9',
      'referer': 'https://www.ford.com.tr/fiyat-listesi/otomobil',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
      'cookie': 'CMSPreferredCulture=tr-TR; CMSCookieLevel=200',
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return response.json();
}

// Fetch Fiat PDF with special headers and retry (server may block cloud IPs)
async function fetchFiatPdf(url: string): Promise<any> {
  const maxRetries = 2;
  let lastError: Error | null = null;

  // Try direct connection first
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`    Direct attempt ${attempt}/${maxRetries}...`);

      // Add delay between retries
      if (attempt > 1) {
        const delay = Math.pow(2, attempt - 1) * 1000;
        console.log(`    Waiting ${delay / 1000}s before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      console.log(`    Connecting to: ${url}`);
      const response = await fetchWithTimeout(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'application/pdf,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
          'Accept-Encoding': 'gzip, deflate, br',
          'Referer': 'https://kampanya.fiat.com.tr/',
          'Origin': 'https://kampanya.fiat.com.tr',
          'Connection': 'keep-alive',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
        },
      });

      // Log response details
      console.log(`    Response status: ${response.status} ${response.statusText}`);
      console.log(`    Response headers: content-type=${response.headers.get('content-type')}, content-length=${response.headers.get('content-length')}`);

      if (!response.ok) {
        const errorBody = await response.text().catch(() => 'Could not read body');
        console.log(`    Response body: ${errorBody.substring(0, 500)}`);
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await extractPdfFromResponse(response, 'fiat');
    } catch (error: any) {
      lastError = error instanceof Error ? error : new Error(String(error));
      logFetchError(error, attempt);
    }
  }

  // Try proxy fallback if direct connection failed
  console.log(`    Direct connection failed, trying proxies...`);
  const proxyServices = [
    { name: 'allorigins', url: `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}` },
    { name: 'corsproxy', url: `https://corsproxy.io/?${encodeURIComponent(url)}` },
    { name: 'codetabs', url: `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}` },
  ];

  const retriesPerProxy = 2;

  for (const proxy of proxyServices) {
    console.log(`    Trying proxy: ${proxy.name}...`);

    for (let attempt = 1; attempt <= retriesPerProxy; attempt++) {
      try {
        console.log(`      ${proxy.name} attempt ${attempt}/${retriesPerProxy}...`);

        // Add delay between retries
        if (attempt > 1) {
          const delay = 2000;
          console.log(`      Waiting ${delay / 1000}s before retry...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }

        const response = await fetchWithTimeout(proxy.url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
        });

        console.log(`      Response: ${response.status} ${response.statusText}`);

        if (response.ok) {
          console.log(`      ${proxy.name} succeeded!`);
          return await extractPdfFromResponse(response, 'fiat');
        } else {
          console.log(`      ${proxy.name} returned HTTP ${response.status}`);
        }
      } catch (error: any) {
        console.log(`      ${proxy.name} attempt ${attempt} failed: ${error.message}`);
      }
    }

    console.log(`    ${proxy.name} exhausted all retries, trying next proxy...`);
  }

  throw lastError || new Error('Failed to fetch Fiat PDF after all retries and proxies');
}

// Helper to extract PDF from response
async function extractPdfFromResponse(response: Response, brand: string): Promise<any> {
  const tempPath = path.join('/tmp', `${brand}-pdf-${Date.now()}.pdf`);
  const buffer = await response.arrayBuffer();
  console.log(`    Downloaded ${buffer.byteLength} bytes`);
  fs.writeFileSync(tempPath, Buffer.from(buffer));

  const pdfExtract = new PDFExtract();
  const pdfData = await promiseWithTimeout(pdfExtract.extract(tempPath, {}), 60_000, `PDF extract (${brand})`);
  console.log(`    PDF extracted: ${pdfData.pages?.length || 0} pages`);

  // Clean up temp file
  try { fs.unlinkSync(tempPath); } catch { }

  return pdfData;
}

// Helper to log fetch errors
function logFetchError(error: any, attempt: number): void {
  const lastError = error instanceof Error ? error : new Error(String(error));
  console.log(`    Attempt ${attempt} failed: ${lastError.message}`);
  if (error.cause) {
    console.log(`    Error cause: ${JSON.stringify(error.cause, null, 2)}`);
  }
  if (error.code) {
    console.log(`    Error code: ${error.code}`);
  }
  if (error.errno) {
    console.log(`    Error errno: ${error.errno}`);
  }
  if (error.syscall) {
    console.log(`    Error syscall: ${error.syscall}`);
  }
  if (error.hostname) {
    console.log(`    Error hostname: ${error.hostname}`);
  }
}

// Fetch Peugeot PDF with special headers and retry (server may block cloud IPs)
async function fetchPeugeotPdf(url: string): Promise<any> {
  const maxRetries = 2;
  let lastError: Error | null = null;

  // Try direct connection first
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`    Direct attempt ${attempt}/${maxRetries}...`);

      if (attempt > 1) {
        const delay = Math.pow(2, attempt - 1) * 1000;
        console.log(`    Waiting ${delay / 1000}s before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      const response = await fetchWithTimeout(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'application/pdf,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
          'Accept-Encoding': 'gzip, deflate, br',
          'Referer': 'https://kampanya.peugeot.com.tr/',
          'Origin': 'https://kampanya.peugeot.com.tr',
          'Connection': 'keep-alive',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1',
        },
      });

      console.log(`    Response status: ${response.status} ${response.statusText}`);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await extractPdfFromResponse(response, 'peugeot');
    } catch (error: any) {
      lastError = error instanceof Error ? error : new Error(String(error));
      logFetchError(error, attempt);
    }
  }

  // Try proxy fallback if direct connection failed
  console.log(`    Direct connection failed, trying proxies...`);
  const proxyServices = [
    { name: 'allorigins', url: `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}` },
    { name: 'corsproxy', url: `https://corsproxy.io/?${encodeURIComponent(url)}` },
    { name: 'codetabs', url: `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}` },
  ];

  const retriesPerProxy = 2;

  for (const proxy of proxyServices) {
    console.log(`    Trying proxy: ${proxy.name}...`);

    for (let attempt = 1; attempt <= retriesPerProxy; attempt++) {
      try {
        console.log(`      ${proxy.name} attempt ${attempt}/${retriesPerProxy}...`);

        if (attempt > 1) {
          const delay = 2000;
          console.log(`      Waiting ${delay / 1000}s before retry...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }

        const response = await fetchWithTimeout(proxy.url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
        });

        console.log(`      Response: ${response.status} ${response.statusText}`);

        if (response.ok) {
          console.log(`      ${proxy.name} succeeded!`);
          return await extractPdfFromResponse(response, 'peugeot');
        } else {
          console.log(`      ${proxy.name} returned HTTP ${response.status}`);
        }
      } catch (error: any) {
        console.log(`      ${proxy.name} attempt ${attempt} failed: ${error.message}`);
      }
    }

    console.log(`    ${proxy.name} exhausted all retries, trying next proxy...`);
  }

  throw lastError || new Error('Failed to fetch Peugeot PDF after all retries and proxies');
}

// Fetch data from URL (handles single and multi-URL brands)
async function fetchBrandData(brand: BrandConfig): Promise<any> {
  // Handle Citroen's dynamic Next.js URL
  if (brand.parser === 'citroen') {
    console.log(`  Fetching ${brand.name} - extracting build ID from ${brand.url}`);
    const buildId = await extractNextJsBuildId(brand.url);
    if (!buildId) {
      throw new Error('Could not extract Next.js build ID');
    }
    const apiUrl = `https://talep.citroen.com.tr/_next/data/${buildId}/fiyat-listesi.json`;
    console.log(`  Using API URL: ${apiUrl}`);
    return fetchSingleUrl(apiUrl, 'json');
  }

  // Handle Škoda - extract __NEXT_DATA__ directly from HTML
  if (brand.parser === 'skoda') {
    console.log(`  Fetching ${brand.name} HTML from ${brand.url}`);
    const response = await fetchWithTimeout(brand.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html',
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) throw new Error('Could not find __NEXT_DATA__ in Škoda page');
    const nextData = JSON.parse(match[1]);
    return nextData.props;
  }

  // Handle Ford's special headers
  if (brand.parser === 'ford') {
    console.log(`  Fetching ${brand.name} from ${brand.url}`);
    return fetchFordUrl(brand.url);
  }

  // Handle Volvo's dynamic PDF URL (first fetch HTML to find PDF link)
  if (brand.parser === 'volvo') {
    console.log(`  Fetching ${brand.name} - extracting PDF URL from ${brand.url}`);
    const response = await fetchWithTimeout(brand.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: Could not fetch Volvo page`);
    }

    const html = await response.text();

    // Extract PDF URL from HTML (contentstack CDN pattern)
    const pdfMatch = html.match(/https:\/\/azure-eu-assets\.contentstack\.com[^"]+\.pdf/);
    if (!pdfMatch) {
      throw new Error('Could not find PDF URL in Volvo page');
    }

    const pdfUrl = pdfMatch[0];
    console.log(`  Found PDF URL: ${pdfUrl}`);

    // Fetch and parse the PDF
    return fetchSingleUrl(pdfUrl, 'pdf');
  }

  // Handle dynamic year URL (Nissan, Honda)
  if (brand.parser === 'nissan' || brand.parser === 'honda') {
    const currentYear = new Date().getFullYear();
    const years = [currentYear, currentYear - 1];

    for (const year of years) {
      const url = brand.url.replace('{year}', year.toString());
      console.log(`  Trying ${brand.name} for year ${year}: ${url}`);

      try {
        const response = await fetchWithTimeout(url, {
          headers: {
            'accept': 'text/html',
            'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          },
        });

        if (response.ok) {
          const html = await response.text();
          // Check if page has actual price content
          const hasContent = brand.parser === 'honda'
            ? html.includes('table-price-list')
            : html.includes('TL');

          if (hasContent) {
            console.log(`  Found ${brand.name} price list for ${year}`);
            (brand as any)._resolvedYear = year;
            return html;
          } else {
            console.log(`  Page found for ${year} but no price content, trying next...`);
          }
        }
      } catch (error) {
        // Try next year
      }
    }
    throw new Error(`No valid ${brand.name} price list found for years ${years.join(', ')}`);
  }

  // Handle Fiat PDF with special headers (server blocks generic requests)
  if (brand.parser === 'fiat') {
    console.log(`  Fetching ${brand.name} PDF from ${brand.url}`);
    return fetchFiatPdf(brand.url);
  }

  // Handle Peugeot PDF with special headers
  if (brand.parser === 'peugeot') {
    console.log(`  Fetching ${brand.name} PDF from ${brand.url}`);
    return fetchPeugeotPdf(brand.url);
  }

  console.log(`  Fetching ${brand.name} from ${brand.url}`);
  return fetchSingleUrl(brand.url, brand.responseType);
}

// Fetch Mercedes API with special headers
async function fetchMercedesUrl(modelCode: string): Promise<any> {
  const url = `https://pladmin.mercedes-benz.com.tr/api/product/searchByCategoryCode?code=${modelCode}&_includes=ID,Code,Alias,Name,GroupName,ProductAttribute,ProductPrice,TaxRatio,VATRatio,IsActive,ImagePath`;

  const response = await fetchWithTimeout(url, {
    headers: {
      'accept': 'application/json, text/plain, */*',
      'applicationid': 'b7d8f89b-8642-40e7-902e-eae1190c40c0',
      'organizationid': '637ca6c6-9d07-4e59-9c31-e9081b3a9d7b',
      'origin': 'https://fiyat.mercedes-benz.com.tr',
      'referer': 'https://fiyat.mercedes-benz.com.tr/',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return response.json();
}

// Fetch and parse multi-URL brand (like Opel, Mercedes)
async function fetchMultiUrlBrand(brand: BrandConfig): Promise<PriceListRow[]> {
  if (!brand.urls || brand.urls.length === 0) {
    return [];
  }

  const allRows: PriceListRow[] = [];

  // Special handling for Mercedes - urls contain model codes, not full URLs
  if (brand.parser === 'mercedes') {
    for (const modelCode of brand.urls) {
      console.log(`    Fetching model code: ${modelCode}`);

      try {
        const data = await fetchMercedesUrl(modelCode);
        const rows = parseData(data, brand.name, brand.parser);
        console.log(`      Found ${rows.length} rows`);
        allRows.push(...rows);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.log(`      Error: ${errorMessage}`);
      }
    }
    return allRows;
  }

  // Standard multi-URL handling (Opel)
  for (const url of brand.urls) {
    // Extract model name from URL
    const modelMatch = url.match(/\/arac\/([^?/]+)/);
    const modelName = modelMatch ? modelMatch[1] : '';

    console.log(`    Fetching ${modelName} from ${url}`);

    try {
      const html = await fetchSingleUrl(url, 'html');
      const rows = parseData(html, brand.name, brand.parser, modelName);
      console.log(`      Found ${rows.length} rows`);
      allRows.push(...rows);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.log(`      Error: ${errorMessage}`);
    }
  }

  return allRows;
}

// Track pending MongoDB saves so we can await them before disconnecting
const pendingMongoSaves: Promise<void>[] = [];

// Save data to file and MongoDB
// Canonical collection date parts in the Turkish market timezone (Europe/Istanbul),
// so the labeled date (index/dateStr) and the file path always agree regardless of
// the runner's timezone (GitHub Actions runs in UTC). Previously dateStr used UTC
// while the file path used the runner's local time, which could disagree by a day.
function istanbulDateParts(date: Date): { year: string; month: string; day: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find(p => p.type === type)!.value;
  return { year: get('year'), month: get('month'), day: get('day') };
}

function saveData(brandId: string, date: Date, data: StoredData): void {
  const { year, month, day } = istanbulDateParts(date);

  const dirPath = path.join(process.cwd(), 'data', year, month, brandId);
  const filePath = path.join(dirPath, `${day}.json`);

  // Create directory if it doesn't exist
  fs.mkdirSync(dirPath, { recursive: true });

  // Write data to JSON file
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`  Saved to ${filePath}`);

  // Write to MongoDB (async, track promise to await before disconnect)
  const dateStr = `${year}-${month}-${day}`;
  const savePromise = saveVehicleToMongo(brandId, dateStr, data as unknown as Record<string, unknown>).catch(() => { });
  pendingMongoSaves.push(savePromise);
}

// Safe JSON parse with fallback
function safeParseJSON<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    console.warn(`JSON parse failed for ${filePath}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    return fallback;
  }
}

// Load existing index or create new one
function loadIndex(): IndexData {
  const indexPath = path.join(process.cwd(), 'data', 'index.json');
  const defaultIndex: IndexData = {
    lastUpdated: new Date().toISOString(),
    brands: {},
  };

  return safeParseJSON(indexPath, defaultIndex);
}

// Save index
function saveIndex(index: IndexData): void {
  const indexPath = path.join(process.cwd(), 'data', 'index.json');
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8');
  console.log(`Index saved to ${indexPath}`);
}

// Get previous day's data as fallback
function getPreviousData(brandId: string, currentDate: Date): StoredData | null {
  const dataDir = path.join(process.cwd(), 'data');
  const indexPath = path.join(dataDir, 'index.json');

  if (!fs.existsSync(indexPath)) {
    return null;
  }

  const index = safeParseJSON<IndexData>(indexPath, { lastUpdated: '', brands: {} });
  const brandInfo = index.brands[brandId];

  if (!brandInfo || brandInfo.availableDates.length === 0) {
    return null;
  }

  // Get the most recent available date
  const latestDate = brandInfo.availableDates[0]; // Already sorted descending
  const [year, month, day] = latestDate.split('-');
  const filePath = path.join(dataDir, year, month, brandId, `${day}.json`);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  return safeParseJSON<StoredData | null>(filePath, null);
}

// Copy previous data as current day's data (fallback)
function useFallbackData(brandId: string, brandName: string, currentDate: Date, previousData: StoredData): StoredData {
  const fallbackData: StoredData = {
    collectedAt: currentDate.toISOString(),
    brand: brandName,
    brandId: brandId,
    rowCount: previousData.rowCount,
    rows: previousData.rows,
  };

  // Add metadata to indicate this is fallback data
  (fallbackData as any).isFallback = true;
  (fallbackData as any).originalDate = previousData.collectedAt;

  return fallbackData;
}

// Update index with new data
function updateIndex(index: IndexData, brandId: string, brandName: string, dateStr: string, rowCount: number): void {
  if (!index.brands[brandId]) {
    index.brands[brandId] = {
      name: brandName,
      availableDates: [],
      latestDate: dateStr,
      totalRecords: 0,
    };
  }

  const brandIndex = index.brands[brandId];

  // Add date if not already present
  if (!brandIndex.availableDates.includes(dateStr)) {
    brandIndex.availableDates.push(dateStr);
    // Sort dates in descending order (newest first)
    brandIndex.availableDates.sort((a, b) => b.localeCompare(a));
  }

  brandIndex.latestDate = brandIndex.availableDates[0];
  brandIndex.totalRecords = rowCount;
  index.lastUpdated = new Date().toISOString();
}

// Main collection function
async function collectAllBrands(): Promise<void> {
  console.log('='.repeat(60));
  console.log('Price List Collector');
  console.log('='.repeat(60));

  const now = new Date();
  const { year: cy, month: cm, day: cd } = istanbulDateParts(now);
  const dateStr = `${cy}-${cm}-${cd}`; // YYYY-MM-DD in Europe/Istanbul (Turkish market day)

  console.log(`Collection date: ${dateStr}`);
  console.log(`Brands to collect: ${BRANDS.length}`);
  console.log('');

  const index = loadIndex();
  const results: CollectionResult[] = [];

  // Optional filter for testing/targeted re-collection:
  //   COLLECT_BRANDS=volvo,seat npx tsx scripts/collect.ts
  // or: npx tsx scripts/collect.ts volvo seat
  const brandFilter = (process.env.COLLECT_BRANDS || process.argv.slice(2).join(','))
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  const brandsToCollect = brandFilter.length > 0
    ? BRANDS.filter(b => brandFilter.includes(b.id.toLowerCase()))
    : BRANDS;
  if (brandFilter.length > 0) {
    console.log(`Filter active: collecting ${brandsToCollect.map(b => b.id).join(', ') || '(none matched)'}`);
  }

  for (const brand of brandsToCollect) {
    const brandStart = Date.now();
    console.log(`[${brand.name}] Starting collection...`);

    try {
      const result = await promiseWithTimeout((async (): Promise<CollectionResult> => {
        let rawRows: PriceListRow[];

        // Check if brand uses multiple URLs
        if (brand.urls && brand.urls.length > 0) {
          rawRows = await fetchMultiUrlBrand(brand);
        } else {
          const data = await fetchBrandData(brand);
          rawRows = parseData(data, brand.name, brand.parser);
        }

        // Fill modelYear from resolved URL year (Honda, Nissan)
        const resolvedYear = (brand as any)._resolvedYear;
        if (resolvedYear) {
          rawRows.forEach(r => { if (!r.modelYear) r.modelYear = resolvedYear; });
        }

        const rows = filterValidRows(rawRows, brand.name);

        if (rows.length === 0) {
          // Try fallback if no rows parsed
          console.log(`  Warning: No rows parsed for ${brand.name}, trying fallback...`);
          const previousData = getPreviousData(brand.id, now);

          if (previousData) {
            const fallbackData = useFallbackData(brand.id, brand.name, now, previousData);
            saveData(brand.id, now, fallbackData);
            updateIndex(index, brand.id, brand.name, dateStr, fallbackData.rowCount);
            console.log(`  Fallback: Using previous data (${fallbackData.rowCount} rows)`);
            return { brand: brand.id, success: true, count: fallbackData.rowCount, usedFallback: true, elapsed: Date.now() - brandStart };
          } else {
            console.log(`  Error: No fallback data available`);
            return { brand: brand.id, success: false, error: 'No rows parsed and no fallback available', elapsed: Date.now() - brandStart };
          }
        }

        const storedData: StoredData = {
          collectedAt: now.toISOString(),
          brand: brand.name,
          brandId: brand.id,
          rowCount: rows.length,
          rows,
        };

        saveData(brand.id, now, storedData);
        updateIndex(index, brand.id, brand.name, dateStr, rows.length);

        console.log(`  Success: ${rows.length} rows collected`);
        return { brand: brand.id, success: true, count: rows.length, elapsed: Date.now() - brandStart };
      })(), 120_000, `Brand: ${brand.name}`);

      results.push(result);
      console.log(`[${brand.name}] Completed in ${((result.elapsed || (Date.now() - brandStart)) / 1000).toFixed(1)}s`);
    } catch (error) {
      const elapsed = Date.now() - brandStart;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isTimeout = errorMessage.includes('Timeout');
      console.error(`[${brand.name}] FAILED after ${(elapsed / 1000).toFixed(1)}s`);
      console.error(`  Type: ${isTimeout ? 'TIMEOUT' : 'ERROR'}`);
      console.error(`  Message: ${errorMessage}`);
      console.error(`  URL: ${brand.url}`);
      if (error instanceof Error && error.stack) {
        console.error(`  Stack: ${error.stack.split('\n').slice(0, 3).join('\n    ')}`);
      }

      // Log to ErrorLogger
      ErrorLogger.logError({
        category: 'HTTP_ERROR',
        source: 'collection',
        brand: brand.name,
        brandId: brand.id,
        code: isTimeout ? 'COLLECTION_TIMEOUT' : 'COLLECTION_FAILED',
        message: `Failed to collect ${brand.name}: ${errorMessage}`,
        details: { error: errorMessage, url: brand.url, elapsed, isTimeout },
        recovered: false,
      });

      // Try fallback on error
      console.log(`[${brand.name}] Attempting fallback to previous data...`);
      const previousData = getPreviousData(brand.id, now);

      if (previousData) {
        const fallbackData = useFallbackData(brand.id, brand.name, now, previousData);
        saveData(brand.id, now, fallbackData);
        updateIndex(index, brand.id, brand.name, dateStr, fallbackData.rowCount);
        console.log(`  Fallback: Using previous data (${fallbackData.rowCount} rows)`);
        results.push({ brand: brand.id, success: true, count: fallbackData.rowCount, usedFallback: true, elapsed });

        // Update error as recovered
        ErrorLogger.logWarning({
          category: 'DATA_QUALITY_ERROR',
          source: 'collection',
          brand: brand.name,
          brandId: brand.id,
          code: 'USING_FALLBACK_DATA',
          message: `Using fallback data for ${brand.name} (${fallbackData.rowCount} rows)`,
          recovered: true,
          recoveryMethod: 'Used previous day data',
        });
      } else {
        console.log(`  Error: No fallback data available`);
        results.push({ brand: brand.id, success: false, error: errorMessage, elapsed });
      }
    }

    console.log('');
  }

  // Save errors before saving index
  await ErrorLogger.saveErrors();

  // Save updated index
  saveIndex(index);

  // Generate health report
  const fallbackUsed = results.filter(r => r.usedFallback);
  const healthReport = {
    generatedAt: now.toISOString(),
    date: dateStr,
    totalBrands: results.length,
    successful: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
    usedFallback: fallbackUsed.length,
    details: results.map(r => ({
      brand: r.brand,
      success: r.success,
      count: r.count || 0,
      error: r.error || null,
      usedFallback: r.usedFallback || false,
      elapsed: r.elapsed || 0,
    })),
  };

  const healthPath = path.join(process.cwd(), 'data', 'health-report.json');
  fs.writeFileSync(healthPath, JSON.stringify(healthReport, null, 2), 'utf-8');
  console.log(`Health report saved to ${healthPath}`);

  // Summary table
  const totalElapsed = results.reduce((sum, r) => sum + (r.elapsed || 0), 0);
  const successful = results.filter(r => r.success && !r.usedFallback);
  const failed = results.filter(r => !r.success);

  console.log('');
  console.log('='.repeat(60));
  console.log('Collection Summary');
  console.log('='.repeat(60));
  console.log('Brand            | Status    | Rows | Time    | Notes');
  console.log('-----------------+-----------+------+---------+------------------');

  // Map brand IDs to display names
  const brandNameMap = new Map(BRANDS.map(b => [b.id, b.name]));

  for (const r of results) {
    const name = (brandNameMap.get(r.brand) || r.brand).padEnd(16).slice(0, 16);
    const status = r.usedFallback ? 'FALLBACK' : r.success ? 'SUCCESS' : 'FAILED';
    const statusStr = status.padEnd(9);
    const rows = String(r.count || 0).padStart(4);
    const time = `${((r.elapsed || 0) / 1000).toFixed(1)}s`.padStart(7);
    const notes = r.error ? r.error.slice(0, 30) : r.usedFallback ? 'Used previous data' : '';
    console.log(`${name} | ${statusStr} | ${rows} | ${time} | ${notes}`);
  }

  console.log('='.repeat(60));
  console.log(`Total: ${results.length} brands | ${successful.length} OK | ${fallbackUsed.length} Fallback | ${failed.length} Failed | ${(totalElapsed / 1000).toFixed(1)}s total`);

  if (failed.length > 0) {
    console.log('\nFailed brands:');
    failed.forEach(r => console.log(`  - ${r.brand}: ${r.error}`));
  }

  // Wait for all pending MongoDB saves to complete before disconnecting
  if (pendingMongoSaves.length > 0) {
    await Promise.allSettled(pendingMongoSaves);
  }
  await disconnectMongo();

  // Exit with appropriate code
  if (successful.length === 0) {
    console.log('\nCritical: All brands failed, exiting with error');
    process.exit(1);
  }

  process.exit(0);
}

// Run
collectAllBrands().catch(async error => {
  console.error('Fatal error:', error);
  ErrorLogger.logError({
    category: 'FILE_ERROR',
    source: 'collection',
    code: 'FATAL_ERROR',
    message: `Fatal error in collection: ${error instanceof Error ? error.message : String(error)}`,
    stack: error instanceof Error ? error.stack : undefined,
  });
  await ErrorLogger.saveErrors();
  process.exit(1);
});
