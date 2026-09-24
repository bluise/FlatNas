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

// 回归测试：/api/widgets/batch 与 /api/widgets/:id 返回 memo widget 时，
// 必须用 memo 文件对齐，而不是返回 data.json 里可能落后的镜像。
func TestWidgetEndpointsAlignMemoData(t *testing.T) {
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
	// data.json 里是旧镜像
	dataJSON := `{"groups":[],"widgets":[{"id":"memo-1","type":"memo","data":{"content":"旧镜像内容","server_ts":1,"mode":"simple"}},{"id":"todo-1","type":"todo","data":[{"id":"t1","text":"待办","done":false}]}],"version":2}`
	if err := os.WriteFile(dataFile, []byte(dataJSON), 0644); err != nil {
		t.Fatalf("write data file: %v", err)
	}
	// memo 文件里才是最新内容
	memoJSON := `{"content":"最新备忘内容","server_ts":999,"mode":"simple"}`
	if err := os.WriteFile(filepath.Join(dataDir, "memo_admin_memo-1.json"), []byte(memoJSON), 0644); err != nil {
		t.Fatalf("write memo file: %v", err)
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

	withUser := func(c *gin.Context) {
		c.Set("username", "admin")
		c.Next()
	}
	router := gin.New()
	router.POST("/api/widgets/batch", withUser, GetWidgetsBatch)
	router.GET("/api/widgets/:id", withUser, GetWidget)

	// 1) 批量接口
	batchRecorder := httptest.NewRecorder()
	batchReq := httptest.NewRequest(http.MethodPost, "/api/widgets/batch", bytes.NewReader([]byte(`{"ids":["memo-1","todo-1"]}`)))
	batchReq.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(batchRecorder, batchReq)
	if batchRecorder.Code != http.StatusOK {
		t.Fatalf("batch status=%d body=%s", batchRecorder.Code, batchRecorder.Body.String())
	}
	var batchResp struct {
		Success bool `json:"success"`
		Widgets []struct {
			ID   string          `json:"id"`
			Type string          `json:"type"`
			Data json.RawMessage `json:"data"`
		} `json:"widgets"`
	}
	if err := json.Unmarshal(batchRecorder.Body.Bytes(), &batchResp); err != nil {
		t.Fatalf("unmarshal batch response: %v", err)
	}
	var memoRaw, todoRaw json.RawMessage
	for i := range batchResp.Widgets {
		switch batchResp.Widgets[i].ID {
		case "memo-1":
			memoRaw = batchResp.Widgets[i].Data
		case "todo-1":
			todoRaw = batchResp.Widgets[i].Data
		}
	}
	if memoRaw == nil || todoRaw == nil {
		t.Fatalf("batch 应同时返回 memo 与 todo, got %s", batchRecorder.Body.String())
	}
	var memoData MemoFileData
	if err := json.Unmarshal(memoRaw, &memoData); err != nil {
		t.Fatalf("memo data 应为对象: %v (%s)", err, string(memoRaw))
	}
	if memoData.Content != "最新备忘内容" || memoData.ServerTS != 999 {
		t.Fatalf("批量接口未对齐 memo：got content=%q ts=%d", memoData.Content, memoData.ServerTS)
	}
	// todo 的 data 是数组，必须原样透传
	var todoData []map[string]interface{}
	if err := json.Unmarshal(todoRaw, &todoData); err != nil {
		t.Fatalf("todo data 应为数组: %v (%s)", err, string(todoRaw))
	}
	if len(todoData) != 1 || todoData[0]["text"] != "待办" {
		t.Fatalf("todo data 被改动：%s", string(todoRaw))
	}

	// 2) 单 widget 接口（memo）
	singleRecorder := httptest.NewRecorder()
	router.ServeHTTP(singleRecorder, httptest.NewRequest(http.MethodGet, "/api/widgets/memo-1", nil))
	if singleRecorder.Code != http.StatusOK {
		t.Fatalf("single status=%d body=%s", singleRecorder.Code, singleRecorder.Body.String())
	}
	var singleResp struct {
		Success bool `json:"success"`
		Data    struct {
			Content  string `json:"content"`
			ServerTS int64  `json:"server_ts"`
		} `json:"data"`
	}
	if err := json.Unmarshal(singleRecorder.Body.Bytes(), &singleResp); err != nil {
		t.Fatalf("unmarshal single response: %v", err)
	}
	if singleResp.Data.Content != "最新备忘内容" || singleResp.Data.ServerTS != 999 {
		t.Fatalf("单 widget 接口未对齐 memo：got content=%q ts=%d", singleResp.Data.Content, singleResp.Data.ServerTS)
	}
}
