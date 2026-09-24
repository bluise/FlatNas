package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"flatnasgo-backend/config"
	"flatnasgo-backend/models"

	"github.com/gin-gonic/gin"
)

// memoContentFromResponse 从 /api/data 响应里取出指定 memo widget 的 content。
func memoContentFromResponse(t *testing.T, body []byte, widgetID string) string {
	t.Helper()
	var payload map[string]interface{}
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("unmarshal /api/data body: %v", err)
	}
	widgets, ok := payload["widgets"].([]interface{})
	if !ok {
		t.Fatalf("widgets missing in response: %s", string(body))
	}
	for _, raw := range widgets {
		widget, ok := raw.(map[string]interface{})
		if !ok {
			continue
		}
		if id, _ := widget["id"].(string); id != widgetID {
			continue
		}
		data, _ := widget["data"].(map[string]interface{})
		content, _ := data["content"].(string)
		return content
	}
	t.Fatalf("widget %s not found in response", widgetID)
	return ""
}

// 回归测试：写入 memo 后 /api/data 的缓存与 ETag 必须失效，
// 否则其他标签页/设备在缓存有效期内会读到旧备忘 —— 表现为"删掉的内容又冒出来"。
func TestSaveMemoInvalidatesGetDataCacheAndETag(t *testing.T) {
	gin.SetMode(gin.TestMode)

	tempDir := t.TempDir()
	dataDir := filepath.Join(tempDir, "data")
	usersDir := filepath.Join(dataDir, "users")
	if err := os.MkdirAll(usersDir, 0755); err != nil {
		t.Fatalf("mkdir users dir: %v", err)
	}

	systemFile := filepath.Join(dataDir, "system.json")
	dataFile := filepath.Join(dataDir, "data.json")
	if err := os.WriteFile(systemFile, []byte(`{"authMode":"single","enableDocker":false}`), 0644); err != nil {
		t.Fatalf("write system config: %v", err)
	}
	dataJSON := `{"groups":[],"widgets":[{"id":"memo-1","type":"memo","data":{"content":"","server_ts":0,"mode":"simple"}}],"version":1}`
	if err := os.WriteFile(dataFile, []byte(dataJSON), 0644); err != nil {
		t.Fatalf("write data file: %v", err)
	}

	oldDataDir := config.DataDir
	oldUsersDir := config.UsersDir
	oldSystemConfigFile := config.SystemConfigFile
	oldSysConfigCache := sysConfigCache
	oldSysConfigCacheMod := sysConfigCacheMod
	oldGetDataCache := getDataCache
	config.DataDir = dataDir
	config.UsersDir = usersDir
	config.SystemConfigFile = systemFile
	sysConfigCache = models.SystemConfig{}
	sysConfigCacheMod = time.Time{}
	getDataCache = map[string]getDataCacheEntry{}
	t.Cleanup(func() {
		config.DataDir = oldDataDir
		config.UsersDir = oldUsersDir
		config.SystemConfigFile = oldSystemConfigFile
		sysConfigCache = oldSysConfigCache
		sysConfigCacheMod = oldSysConfigCacheMod
		getDataCache = oldGetDataCache
	})

	// GetData / SaveMemo 正常都在鉴权中间件之后运行，这里直接注入 username
	withUser := func(c *gin.Context) {
		c.Set("username", "admin")
		c.Next()
	}
	router := gin.New()
	router.GET("/api/data", withUser, GetData)
	router.PUT("/api/memo/:id", withUser, SaveMemo)

	// 1. 首次读取，拿到 ETag 并让 /api/data 进入缓存
	firstRecorder := httptest.NewRecorder()
	router.ServeHTTP(firstRecorder, httptest.NewRequest(http.MethodGet, "/api/data", nil))
	if firstRecorder.Code != http.StatusOK {
		t.Fatalf("expected first /api/data 200, got %d", firstRecorder.Code)
	}
	oldETag := firstRecorder.Header().Get("ETag")
	if oldETag == "" {
		t.Fatal("expected ETag header")
	}
	if got := memoContentFromResponse(t, firstRecorder.Body.Bytes(), "memo-1"); got != "" {
		t.Fatalf("expected empty memo before save, got %q", got)
	}

	// 2. 写入 memo（server_ts 与磁盘一致，应成功）
	saveBody := []byte(`{"content":"新的备忘内容","server_ts":0,"mode":"simple"}`)
	saveRecorder := httptest.NewRecorder()
	saveRequest := httptest.NewRequest(http.MethodPut, "/api/memo/memo-1", bytes.NewReader(saveBody))
	saveRequest.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(saveRecorder, saveRequest)
	if saveRecorder.Code != http.StatusOK {
		t.Fatalf("expected memo save 200, got %d body=%s", saveRecorder.Code, saveRecorder.Body.String())
	}

	// 3. 再读 /api/data：ETag 必须变化，不能命中 304 拿到旧内容
	revalidateRecorder := httptest.NewRecorder()
	revalidateRequest := httptest.NewRequest(http.MethodGet, "/api/data", nil)
	revalidateRequest.Header.Set("If-None-Match", oldETag)
	router.ServeHTTP(revalidateRecorder, revalidateRequest)
	if revalidateRecorder.Code == http.StatusNotModified {
		t.Fatal("memo 变更后 /api/data 不应返回 304（旧 ETag 仍被认为有效，客户端会一直读到旧备忘）")
	}
	if newETag := revalidateRecorder.Header().Get("ETag"); newETag == oldETag {
		t.Fatalf("memo 变更后 ETag 应变化，实际仍为 %q", newETag)
	}
	if got := memoContentFromResponse(t, revalidateRecorder.Body.Bytes(), "memo-1"); got != "新的备忘内容" {
		t.Fatalf("expected updated memo content, got %q", got)
	}

	// 4. 不带条件头再读一次，确认内存缓存也已被丢弃（重新读盘对齐 memo 文件）
	cacheRecorder := httptest.NewRecorder()
	router.ServeHTTP(cacheRecorder, httptest.NewRequest(http.MethodGet, "/api/data", nil))
	if cacheRecorder.Code != http.StatusOK {
		t.Fatalf("expected third /api/data 200, got %d", cacheRecorder.Code)
	}
	if got := memoContentFromResponse(t, cacheRecorder.Body.Bytes(), "memo-1"); got != "新的备忘内容" {
		t.Fatalf("expected cached response to be refreshed, got %q", got)
	}
}
