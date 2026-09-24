package handlers

import (
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

// 多副本场景回归测试：
// 另一个副本写入 memo 文件时，本副本进程内的缓存不该继续返回旧内容。
// 这里直接改文件来模拟"别的副本写的"，完全不经过本进程的 invalidateGetDataCache。
func TestGetDataCacheDetectsMemoChangeFromAnotherReplica(t *testing.T) {
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
	// 镜像为空，memo 文件才是权威
	dataJSON := `{"groups":[],"widgets":[{"id":"memo-1","type":"memo","data":{"content":"","server_ts":0,"mode":"simple"}}],"version":1}`
	if err := os.WriteFile(dataFile, []byte(dataJSON), 0644); err != nil {
		t.Fatalf("write data file: %v", err)
	}
	memoFile := filepath.Join(dataDir, "memo_admin_memo-1.json")
	if err := os.WriteFile(memoFile, []byte(`{"content":"初始内容","server_ts":10,"mode":"simple"}`), 0644); err != nil {
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
	router.GET("/api/data", withUser, GetData)

	requestData := func(ifNoneMatch string) *httptest.ResponseRecorder {
		t.Helper()
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/api/data", nil)
		if ifNoneMatch != "" {
			req.Header.Set("If-None-Match", ifNoneMatch)
		}
		router.ServeHTTP(recorder, req)
		return recorder
	}

	// 1. 第一次请求：让本副本的 /api/data 进入内存缓存
	first := requestData("")
	if first.Code != http.StatusOK {
		t.Fatalf("首次 /api/data status=%d", first.Code)
	}
	firstETag := first.Header().Get("ETag")
	if got := memoContentFromResponse(t, first.Body.Bytes(), "memo-1"); got != "初始内容" {
		t.Fatalf("首次内容应为初始内容, got %q", got)
	}

	// 2. 模拟"另一个副本"直接写 memo 文件（本进程完全没有收到任何失效通知）
	time.Sleep(5 * time.Millisecond)
	if err := os.WriteFile(memoFile, []byte(`{"content":"别的副本写入的内容","server_ts":20,"mode":"simple"}`), 0644); err != nil {
		t.Fatalf("rewrite memo file: %v", err)
	}

	// 3. 本副本再读：内存缓存必须被文件指纹识破，返回新内容
	second := requestData("")
	if second.Code != http.StatusOK {
		t.Fatalf("二次 /api/data status=%d", second.Code)
	}
	if got := memoContentFromResponse(t, second.Body.Bytes(), "memo-1"); got != "别的副本写入的内容" {
		t.Fatalf("多副本下缓存未感知 memo 变更：got %q", got)
	}

	// 4. 旧 ETag 也必须失效（不能回 304 让客户端继续用旧内容）
	third := requestData(firstETag)
	if third.Code == http.StatusNotModified {
		t.Fatal("memo 变更后旧 ETag 仍被认为有效（多副本下客户端会一直读到旧备忘）")
	}
	if newETag := third.Header().Get("ETag"); newETag == firstETag {
		t.Fatalf("memo 变更后 ETag 应变化，实际仍为 %q", newETag)
	}
	if got := memoContentFromResponse(t, third.Body.Bytes(), "memo-1"); got != "别的副本写入的内容" {
		t.Fatalf("ETag 路径返回了旧内容：got %q", got)
	}
}
