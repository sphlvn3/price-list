package repository

import (
	"context"
	"sort"
	"time"

	"github.com/spehlivan/price-list/backend/internal/models"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

type VehicleRepository struct {
	collection *mongo.Collection
}

func NewVehicleRepository(db *mongo.Database) *VehicleRepository {
	return &VehicleRepository{
		collection: db.Collection("vehicles"),
	}
}

// GetIndex builds the index response by aggregating available dates per brand
func (r *VehicleRepository) GetIndex(ctx context.Context) (*models.IndexData, error) {
	pipeline := bson.A{
		bson.D{{Key: "$sort", Value: bson.D{{Key: "date", Value: -1}}}},
		bson.D{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: "$brandId"},
			{Key: "name", Value: bson.D{{Key: "$first", Value: "$brand"}}},
			{Key: "dates", Value: bson.D{{Key: "$addToSet", Value: "$date"}}},
			{Key: "totalRecords", Value: bson.D{{Key: "$first", Value: "$rowCount"}}},
		}}},
		bson.D{{Key: "$sort", Value: bson.D{{Key: "_id", Value: 1}}}},
	}

	cursor, err := r.collection.Aggregate(ctx, pipeline)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)

	type aggResult struct {
		ID           string   `bson:"_id"`
		Name         string   `bson:"name"`
		Dates        []string `bson:"dates"`
		TotalRecords int      `bson:"totalRecords"`
	}

	brands := make(map[string]models.BrandIndexData)
	for cursor.Next(ctx) {
		var result aggResult
		if err := cursor.Decode(&result); err != nil {
			continue
		}

		// Sort dates descending
		sort.Sort(sort.Reverse(sort.StringSlice(result.Dates)))

		latestDate := ""
		if len(result.Dates) > 0 {
			latestDate = result.Dates[0]
		}

		brands[result.ID] = models.BrandIndexData{
			Name:           result.Name,
			AvailableDates: result.Dates,
			LatestDate:     latestDate,
			TotalRecords:   result.TotalRecords,
		}
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}

	return &models.IndexData{
		LastUpdated: time.Now().UTC().Format(time.RFC3339),
		Brands:      brands,
	}, nil
}

// GetLatest returns the latest data for all brands (single aggregation query)
func (r *VehicleRepository) GetLatest(ctx context.Context) (*models.LatestData, error) {
	pipeline := bson.A{
		bson.D{{Key: "$sort", Value: bson.D{
			{Key: "brandId", Value: 1},
			{Key: "date", Value: -1},
		}}},
		bson.D{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: "$brandId"},
			{Key: "doc", Value: bson.D{{Key: "$first", Value: "$$ROOT"}}},
		}}},
		bson.D{{Key: "$replaceRoot", Value: bson.D{
			{Key: "newRoot", Value: "$doc"},
		}}},
	}

	cursor, err := r.collection.Aggregate(ctx, pipeline)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)

	brands := make(map[string]models.LatestBrandData)
	totalVehicles := 0

	for cursor.Next(ctx) {
		var doc models.VehicleDocument
		if err := cursor.Decode(&doc); err != nil {
			continue
		}

		brands[doc.BrandID] = models.LatestBrandData{
			Name:     doc.Brand,
			Date:     doc.Date,
			Vehicles: doc.Rows,
		}
		totalVehicles += len(doc.Rows)
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}

	return &models.LatestData{
		GeneratedAt:   time.Now().UTC().Format(time.RFC3339),
		TotalVehicles: totalVehicles,
		Brands:        brands,
	}, nil
}

// GetByBrandAndDate returns vehicle data for a specific brand and date
func (r *VehicleRepository) GetByBrandAndDate(ctx context.Context, brandID, date string) (*models.StoredData, error) {
	filter := bson.D{
		{Key: "brandId", Value: brandID},
		{Key: "date", Value: date},
	}

	var doc models.VehicleDocument
	err := r.collection.FindOne(ctx, filter).Decode(&doc)
	if err != nil {
		return nil, err
	}

	return &models.StoredData{
		CollectedAt: doc.CollectedAt,
		Brand:       doc.Brand,
		BrandID:     doc.BrandID,
		RowCount:    doc.RowCount,
		Rows:        doc.Rows,
	}, nil
}

// TrendPoint represents a single data point in a price trend
type TrendPoint struct {
	Date  string  `json:"date" bson:"date"`
	Price float64 `json:"price" bson:"price"`
}

// GetTrend returns price history for a specific vehicle across recent dates.
// If days > 0, filters to documents within that many days from today.
// Otherwise uses the limit parameter to cap the number of documents.
func (r *VehicleRepository) GetTrend(ctx context.Context, brandID, model, trim, engine string, limit int, days int) ([]TrendPoint, error) {
	if limit <= 0 || limit > 365 {
		limit = 10
	}

	matchFilter := bson.D{{Key: "brandId", Value: brandID}}
	if days > 0 {
		cutoff := time.Now().AddDate(0, 0, -days).Format("2006-01-02")
		matchFilter = append(matchFilter, bson.E{Key: "date", Value: bson.D{{Key: "$gte", Value: cutoff}}})
	}

	pipeline := bson.A{
		bson.D{{Key: "$match", Value: matchFilter}},
		bson.D{{Key: "$sort", Value: bson.D{{Key: "date", Value: -1}}}},
		bson.D{{Key: "$limit", Value: int64(limit)}},
		bson.D{{Key: "$unwind", Value: "$rows"}},
		bson.D{{Key: "$match", Value: bson.D{
			{Key: "rows.model", Value: model},
			{Key: "rows.trim", Value: trim},
			{Key: "rows.engine", Value: engine},
		}}},
		bson.D{{Key: "$match", Value: bson.D{
			{Key: "rows.priceNumeric", Value: bson.D{{Key: "$gt", Value: 0}}},
		}}},
		// Group by date to get one price point per day (handles duplicate rows e.g. different model years)
		bson.D{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: "$date"},
			{Key: "price", Value: bson.D{{Key: "$max", Value: "$rows.priceNumeric"}}},
		}}},
		bson.D{{Key: "$project", Value: bson.D{
			{Key: "date", Value: "$_id"},
			{Key: "price", Value: 1},
			{Key: "_id", Value: 0},
		}}},
		bson.D{{Key: "$sort", Value: bson.D{{Key: "date", Value: 1}}}},
	}

	cursor, err := r.collection.Aggregate(ctx, pipeline)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(ctx)

	var points []TrendPoint
	if err := cursor.All(ctx, &points); err != nil {
		return nil, err
	}

	return points, nil
}

// EnsureIndexes creates the required MongoDB indexes
func (r *VehicleRepository) EnsureIndexes(ctx context.Context) error {
	_, err := r.collection.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys: bson.D{
			{Key: "brandId", Value: 1},
			{Key: "date", Value: -1},
		},
		Options: options.Index().SetUnique(true),
	})
	return err
}
