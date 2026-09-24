package handlers

import (
	"flatnasgo-backend/config"
	"flatnasgo-backend/utils"
	"flatnasgo-backend/ws"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
)

// SaveSingleWidget handles PUT /api/widgets/:id - saves a single widget's data
// without rewriting the entire user data file.
func SaveSingleWidget(c *gin.Context) {
	username := c.GetString("username")
	if username == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Unauthorized"})
		return
	}

	widgetID := c.Param("id")
	if widgetID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Widget ID is required"})
		return
	}

	var payload map[string]interface{}
	if err := c.ShouldBindJSON(&payload); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid JSON"})
		return
	}

	sysConfig := getCachedSystemConfig()
	userFile := filepath.Join(config.UsersDir, username+".json")
	if username == "admin" && sysConfig.AuthMode == "single" {
		userFile = filepath.Join(config.DataDir, "data.json")
	}

	// 串行化"读-改-写"：SaveSingleWidget 只改一个 widget，但整份 userData 会被重写，
	// 并发请求（例如 Todo 与备忘同时保存）会互相覆盖导致丢数据。
	unlockUserData := lockUserData(userFile)
	defer unlockUserData()

	var userData map[string]interface{}
	if err := utils.ReadJSON(userFile, &userData); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "User data not found"})
		return
	}

	// Version check: global dataVersion + optional per-widget widgetVersion
	existingVersion := normalizeVersion(userData["version"])
	clientVersion := int64(0)
	if v, ok := payload["version"]; ok {
		clientVersion = normalizeVersion(v)
	}
	if clientVersion != existingVersion {
		c.JSON(http.StatusConflict, gin.H{"error": "Version conflict", "currentVersion": existingVersion})
		return
	}

	widgets, ok := userData["widgets"].([]interface{})
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "Widgets not found"})
		return
	}

	found := false
	oldWeatherCity := ""
	newWeatherCity := ""
	isWeatherWidget := false
	for i, w := range widgets {
		widgetMap, ok := w.(map[string]interface{})
		if !ok {
			continue
		}
		wID, _ := widgetMap["id"].(string)
		if wID != widgetID {
			continue
		}
		found = true
		wType, _ := widgetMap["type"].(string)
		isWeatherWidget = wType == "weather" || wType == "clockweather" || wType == "clock"
		if isWeatherWidget {
			oldWeatherCity = extractWeatherWidgetCity(widgetMap["data"])
		}

		// Widget-level optimistic lock (optional)
		if clientWidgetVer, ok := payload["widgetVersion"]; ok {
			serverWidgetVer := normalizeVersion(widgetMap["widgetVersion"])
			if clientWidgetVerN := normalizeVersion(clientWidgetVer); clientWidgetVerN != serverWidgetVer {
				c.JSON(http.StatusConflict, gin.H{
					"error":          "Widget version conflict",
					"currentVersion": existingVersion,
					"widgetVersion":  serverWidgetVer,
				})
				return
			}
		}

		// Merge widget data
		if widgetData, ok := payload["data"]; ok {
			widgetMap["data"] = widgetData
			if isWeatherWidget {
				newWeatherCity = extractWeatherWidgetCity(widgetData)
			}
		}
		if enable, ok := payload["enable"]; ok {
			widgetMap["enable"] = enable
		}
		if x, ok := payload["x"]; ok {
			widgetMap["x"] = x
		}
		if y, ok := payload["y"]; ok {
			widgetMap["y"] = y
		}
		if w, ok := payload["w"]; ok {
			widgetMap["w"] = w
		}
		if h, ok := payload["h"]; ok {
			widgetMap["h"] = h
		}

		// Bump widget-level version
		widgetMap["widgetVersion"] = normalizeVersion(widgetMap["widgetVersion"]) + 1

		widgets[i] = widgetMap
		break
	}

	if !found {
		c.JSON(http.StatusNotFound, gin.H{"error": "Widget not found"})
		return
	}

	// Increment global version
	newVersion := existingVersion + 1
	userData["version"] = newVersion

	// Write back to file with lock
	if err := utils.WriteJSON(userFile, userData); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save widget"})
		return
	}

	if isWeatherWidget {
		sharedWeatherPoller.TriggerPollForNewCities([]string{oldWeatherCity}, []string{newWeatherCity})
	}

	// Broadcast update via WebSocket
	wType := ""
	var newWidgetVersion int64
	if widgets, ok := userData["widgets"].([]interface{}); ok {
		for _, w := range widgets {
			if wm, ok := w.(map[string]interface{}); ok {
				if id, _ := wm["id"].(string); id == widgetID {
					wType, _ = wm["type"].(string)
					newWidgetVersion = normalizeVersion(wm["widgetVersion"])
					break
				}
			}
		}
	}

	switch wType {
	case "memo":
		if b := ws.GetBroadcaster(); b != nil {
			// memo 的权威内容在独立的 memo 文件里，payload["data"] 只是客户端提交的镜像
			// （常见于侧边栏等只改 enable/布局的保存），可能已经过期。
			// 直接用它广播会把旧备忘推给其他端。
			broadcastContent := payload["data"]
			memoFile := memoFilePath(username, widgetID)
			unlockMemo := lockMemoFile(memoFile)
			current, memoErr := ensureMemoFile(userFile, memoFile, widgetID, nil, nil, memoLegacyFallbackAllowed(username))
			unlockMemo()
			if memoErr == nil {
				broadcastContent = current
			}
			ws.BroadcastMemoUpdated(b.Manager, username, widgetID, broadcastContent)
		}
	case "todo":
		if b := ws.GetBroadcaster(); b != nil {
			ws.BroadcastTodoUpdated(b.Manager, username, widgetID, payload["data"])
		}
	case "bookmarks":
		if b := ws.GetBroadcaster(); b != nil {
			ws.BroadcastBookmarksUpdated(b.Manager, username, widgetID, payload["data"])
		}
	}

	resp := gin.H{
		"success": true,
		"version": newVersion,
	}
	if newWidgetVersion > 0 {
		resp["widgetVersion"] = newWidgetVersion
	}
	c.JSON(http.StatusOK, resp)
}

func extractWeatherWidgetCity(raw interface{}) string {
	data, ok := raw.(map[string]interface{})
	if !ok {
		return ""
	}
	city, _ := data["city"].(string)
	return strings.TrimSpace(city)
}
