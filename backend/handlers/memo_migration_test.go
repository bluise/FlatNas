package handlers

import (
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

// 回归测试：memo 落盘迁移完成后再出现"文件缺失"，不能从 data.json 把旧内容回填复活。
func TestMemoFileMissingAfterMigrationDoesNotResurrect(t *testing.T) {
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
	// data.json 里保留着旧备忘内容（模拟历史数据 / 迁移前的形态）
	dataJSON := `{"groups":[],"widgets":[{"id":"memo-1","type":"memo","data":{"content":"旧备忘内容","server_ts":111,"mode":"simple"}}],"version":1}`
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

	withUser := func(c *gin.Context) {
		c.Set("username", "admin")
		c.Next()
	}
	router := gin.New()
	router.GET("/api/data", withUser, GetData)

	requestData := func() []byte {
		t.Helper()
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/data", nil))
		if recorder.Code != http.StatusOK {
			t.Fatalf("expected /api/data 200, got %d body=%s", recorder.Code, recorder.Body.String())
		}
		return recorder.Body.Bytes()
	}

	memoFile := filepath.Join(dataDir, "memo_admin_memo-1.json")
	markerFile := filepath.Join(dataDir, "memo_migrated_admin.json")

	// 1. 首次读取：还没有迁移标记，允许从 data.json 回填，把历史备忘迁移到独立文件
	firstBody := requestData()
	if got := memoContentFromResponse(t, firstBody, "memo-1"); got != "旧备忘内容" {
		t.Fatalf("首次迁移应回填历史内容，got %q", got)
	}
	if _, err := os.Stat(memoFile); err != nil {
		t.Fatalf("首次迁移后应生成 memo 文件: %v", err)
	}
	if _, err := os.Stat(markerFile); err != nil {
		t.Fatalf("首次迁移后应写入标记文件: %v", err)
	}

	// 2. 模拟 memo 文件丢失（data.json 里仍残留旧内容）
	if err := os.Remove(memoFile); err != nil {
		t.Fatalf("remove memo file: %v", err)
	}
	// 清掉 /api/data 内存缓存，等价于缓存过期或进程重启
	getDataCache = map[string]getDataCacheEntry{}

	// 3. 再读：迁移已完成，缺失的 memo 文件应视为"已删除"，不得复活旧内容
	secondBody := requestData()
	if got := memoContentFromResponse(t, secondBody, "memo-1"); got != "" {
		t.Fatalf("迁移完成后不应再从 data.json 复活旧备忘，got %q", got)
	}

	// 4. 且重建出来的 memo 文件是空的（server_ts 归零，客户端保存不会反复冲突）
	raw, err := os.ReadFile(memoFile)
	if err != nil {
		t.Fatalf("read rebuilt memo file: %v", err)
	}
	var rebuilt MemoFileData
	if err := json.Unmarshal(raw, &rebuilt); err != nil {
		t.Fatalf("unmarshal rebuilt memo: %v", err)
	}
	if rebuilt.Content != "" || rebuilt.ServerTS != 0 {
		t.Fatalf("重建的 memo 应为空且 server_ts=0, got content=%q ts=%d", rebuilt.Content, rebuilt.ServerTS)
	}
}
