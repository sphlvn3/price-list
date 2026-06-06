package handlers

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/spehlivan/price-list/backend/internal/repository"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

type VehicleHandler struct {
	repo *repository.VehicleRepository
}

func NewVehicleHandler(repo *repository.VehicleRepository) *VehicleHandler {
	return &VehicleHandler{repo: repo}
}

// GetIndex returns available dates per brand
func (h *VehicleHandler) GetIndex(c *gin.Context) {
	data, err := h.repo.GetIndex(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to fetch index"})
		return
	}
	c.JSON(http.StatusOK, data)
}

// GetLatest returns the latest data for all brands
func (h *VehicleHandler) GetLatest(c *gin.Context) {
	data, err := h.repo.GetLatest(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to fetch latest data"})
		return
	}
	c.JSON(http.StatusOK, data)
}

// GetTrend returns price history for a specific vehicle
func (h *VehicleHandler) GetTrend(c *gin.Context) {
	brand := c.Query("brand")
	model := c.Query("model")
	trim := c.Query("trim")
	engine := c.Query("engine")

	if brand == "" || model == "" || trim == "" || engine == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "brand, model, trim, and engine query parameters are required"})
		return
	}

	limit := 10
	days := 0
	if d := c.Query("days"); d != "" {
		if parsed, err := strconv.Atoi(d); err == nil && parsed > 0 {
			if parsed > 3650 {
				parsed = 3650 // cap at ~10 years to bound the query (avoid abuse)
			}
			days = parsed
			limit = parsed // allow up to `days` data points
		}
	}

	points, err := h.repo.GetTrend(c.Request.Context(), brand, model, trim, engine, limit, days)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to fetch trend data"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"points": points})
}

// GetVehicles returns vehicle data for a specific brand and date
func (h *VehicleHandler) GetVehicles(c *gin.Context) {
	brand := c.Query("brand")
	date := c.Query("date")

	if brand == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "brand query parameter is required"})
		return
	}

	if date == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "date query parameter is required"})
		return
	}

	data, err := h.repo.GetByBrandAndDate(c.Request.Context(), brand, date)
	if err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			c.JSON(http.StatusNotFound, gin.H{"error": "Data not found for the specified brand and date"})
		} else {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to fetch vehicle data"})
		}
		return
	}

	c.JSON(http.StatusOK, data)
}
