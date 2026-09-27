package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"flatnasgo-backend/config"

	"github.com/gin-gonic/gin"
)

// 家庭网络心跳的回归用例：这套判据是公网 VPS + 动态出口 IP（含 CGNAT）场景下
// 唯一可用的「我在家」信号，所以匹配规则、过期剔除、token 鉴权都要锁住。

func setupHomeBeaconTest(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	old := config.DataDir
	config.DataDir = dir
	t.Cleanup(func() { config.DataDir = old })
}

func seedHomeBeacon(t *testing.T, records []homeBeaconRecord, prefixMatch bool) string {
	t.Helper()
	token := newHomeBeaconToken()
	state := homeBeaconState{Token: token, PrefixMatch: prefixMatch, Records: records}
	if err := saveHomeBeaconState(state); err != nil {
		t.Fatalf("seed state: %v", err)
	}
	return token
}

func TestHomeBeaconExactMatch(t *testing.T) {
	setupHomeBeaconTest(t)
	seedHomeBeacon(t, []homeBeaconRecord{{IP: "113.87.10.20", At: time.Now()}}, true)

	matched, hit := homeBeaconMatch("113.87.10.20")
	if !matched {
		t.Fatalf("同一出口 IP 应判定为在家")
	}
	if hit != "113.87.10.20" {
		t.Fatalf("命中记录应为 113.87.10.20，实际 %q", hit)
	}
	if matched, _ := homeBeaconMatch(""); matched {
		t.Fatalf("空 IP 不应命中")
	}
}

func TestHomeBeaconPrefixMatchWithinSame24(t *testing.T) {
	setupHomeBeaconTest(t)
	seedHomeBeacon(t, []homeBeaconRecord{{IP: "113.87.10.20", At: time.Now()}}, true)

	// CGNAT 下手机与 NAS 可能落在同一池子的不同公网 IP 上
	if matched, _ := homeBeaconMatch("113.87.10.99"); !matched {
		t.Fatalf("同 /24 应判定为在家（CGNAT 池内漂移）")
	}
	if matched, _ := homeBeaconMatch("113.87.11.20"); matched {
		t.Fatalf("跨 /24 不应命中，否则会误判成在家")
	}
}

func TestHomeBeaconPrefixMatchCanBeDisabled(t *testing.T) {
	setupHomeBeaconTest(t)
	seedHomeBeacon(t, []homeBeaconRecord{{IP: "113.87.10.20", At: time.Now()}}, false)

	if matched, _ := homeBeaconMatch("113.87.10.20"); !matched {
		t.Fatalf("关闭同网段匹配后，精确命中仍应生效")
	}
	if matched, _ := homeBeaconMatch("113.87.10.99"); matched {
		t.Fatalf("关闭同网段匹配后，同 /24 其他 IP 不应命中")
	}
}

func TestHomeBeaconExpiredRecordsIgnored(t *testing.T) {
	setupHomeBeaconTest(t)
	seedHomeBeacon(t, []homeBeaconRecord{
		{IP: "113.87.10.20", At: time.Now().Add(-homeBeaconMatchTTL - time.Minute)},
	}, true)

	if matched, _ := homeBeaconMatch("113.87.10.20"); matched {
		t.Fatalf("过期记录（IP 可能已被运营商分配给别人）不应参与匹配")
	}
}

func TestHomeBeaconPingRequiresToken(t *testing.T) {
	setupHomeBeaconTest(t)
	token := seedHomeBeacon(t, nil, true)
	gin.SetMode(gin.TestMode)

	call := func(q string) int {
		rec := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(rec)
		c.Request = httptest.NewRequest(http.MethodGet, "/api/home-beacon/ping"+q, nil)
		c.Request.RemoteAddr = "113.87.10.20:34567"
		HomeBeaconPing(c)
		return rec.Code
	}

	if code := call(""); code != http.StatusForbidden {
		t.Fatalf("无 token 应 403，实际 %d", code)
	}
	if code := call("?token=wrong"); code != http.StatusForbidden {
		t.Fatalf("错误 token 应 403，实际 %d", code)
	}
	if code := call("?token=" + token); code != http.StatusOK {
		t.Fatalf("正确 token 应 200，实际 %d", code)
	}

	if matched, _ := homeBeaconMatch("113.87.10.20"); !matched {
		t.Fatalf("心跳上报后，该来源 IP 应被记为家庭出口 IP")
	}
}

func TestSaveHomeBeaconStateKeepsPrefixMatchDefault(t *testing.T) {
	setupHomeBeaconTest(t)
	// 老版本状态文件没有 prefixMatch 字段时，应默认按「开启」处理
	raw := `{"token":"abc","records":[]}`
	if err := os.WriteFile(filepath.Join(config.DataDir, homeBeaconFileName), []byte(raw), 0644); err != nil {
		t.Fatalf("write legacy state: %v", err)
	}
	state := loadHomeBeaconState()
	if !state.PrefixMatch {
		t.Fatalf("缺少 prefixMatch 字段的老状态文件应默认开启同网段匹配")
	}
	if state.Token != "abc" {
		t.Fatalf("token 应保留，实际 %q", state.Token)
	}
}

// 用 json 断言一下接口返回结构，避免前端字段对不上
func TestHomeBeaconInfoPayloadShape(t *testing.T) {
	setupHomeBeaconTest(t)
	seedHomeBeacon(t, []homeBeaconRecord{{IP: "113.87.10.20", At: time.Now(), Source: "header"}}, true)
	_, state := ensureHomeBeaconToken()
	raw, err := json.Marshal(homeBeaconInfoPayload(state))
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	for _, key := range []string{"token", "prefixMatch", "records"} {
		if !strings.Contains(string(raw), `"`+key+`"`) {
			t.Fatalf("响应缺少字段 %s: %s", key, string(raw))
		}
	}
}
