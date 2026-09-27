package handlers

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flatnasgo-backend/config"
	"flatnasgo-backend/utils"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// 家庭网络心跳（beacon）
//
// 要解决的问题：FlatNas 架在公网 VPS 上时，「我现在是否在家」唯一可靠的判据是
// 「客户端出口 IP == 家里的出口 IP」。但家宽出口 IP 会变（运营商 CGNAT 尤其频繁），
// 手动填写很快就失效。
//
// 做法：让家里任意一台 24 小时在线的设备（NAS / 路由器 / 软路由）定时请求
// /api/home-beacon/ping?token=xxx。服务端**把这次请求的来源 IP 记成家庭出口 IP**，
// 于是 IP 怎么变都会在几分钟内被自动刷新，用户不需要维护任何东西。
//
// 设备只要能发出站请求即可：不要求家里有公网 IP、不要求端口映射，
// 因此大内网 / CGNAT / 双 NAT / 二级路由都不影响。
//
// 状态单独存 home_beacon.json，不去读改写 data.json（避免与用户配置互相踩）。

const (
	homeBeaconFileName = "home_beacon.json"
	// 心跳记录参与匹配的有效期：超过这个时间的记录视为过期（IP 可能已被运营商回收给别人）
	homeBeaconMatchTTL = 6 * time.Hour
	// 状态文件里最多保留多少条历史记录
	homeBeaconMaxRecords = 12
)

type homeBeaconRecord struct {
	IP     string    `json:"ip"`
	At     time.Time `json:"at"`
	Source string    `json:"source"`
}

type homeBeaconState struct {
	Token string `json:"token"`
	// 是否允许「同 /24 也算在家」：CGNAT 下不同设备/不同时刻可能拿到同一池子里不同的公网 IP，
	// 只比精确值容易漏判。默认开启，比较范围仅限 /24，不会跨网段误判。
	PrefixMatch bool               `json:"prefixMatch"`
	Records     []homeBeaconRecord `json:"records"`
	UpdatedAt   time.Time          `json:"updatedAt"`
}

// 用于兼容老状态文件（没有 prefixMatch 字段时应视为 true）
type homeBeaconStateRaw struct {
	Token       string             `json:"token"`
	PrefixMatch *bool              `json:"prefixMatch"`
	Records     []homeBeaconRecord `json:"records"`
	UpdatedAt   time.Time          `json:"updatedAt"`
}

var homeBeaconMu sync.Mutex

func homeBeaconPath() string {
	return filepath.Join(config.DataDir, homeBeaconFileName)
}

func newHomeBeaconToken() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("%032x", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf)
}

func loadHomeBeaconState() homeBeaconState {
	state := homeBeaconState{PrefixMatch: true}
	raw, err := os.ReadFile(homeBeaconPath())
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("[HomeBeacon] 读取失败: %v", err)
		}
		return state
	}
	var parsed homeBeaconStateRaw
	if err := json.Unmarshal(raw, &parsed); err != nil {
		log.Printf("[HomeBeacon] 解析失败: %v", err)
		return state
	}
	state.Token = parsed.Token
	state.Records = parsed.Records
	state.UpdatedAt = parsed.UpdatedAt
	state.PrefixMatch = true
	if parsed.PrefixMatch != nil {
		state.PrefixMatch = *parsed.PrefixMatch
	}
	return state
}

func saveHomeBeaconState(state homeBeaconState) error {
	state.UpdatedAt = time.Now()
	// 跨进程锁，多副本部署时避免互相覆盖
	if unlock, err := utils.AcquireFileLock(homeBeaconPath()+".lock", 3*time.Second); err == nil && unlock != nil {
		defer unlock()
	}
	if err := os.MkdirAll(filepath.Dir(homeBeaconPath()), 0755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	tmp := homeBeaconPath() + ".tmp"
	if err := os.WriteFile(tmp, raw, 0644); err != nil {
		return err
	}
	return os.Rename(tmp, homeBeaconPath())
}

// ensureHomeBeaconToken 返回当前 token，没有就生成并落盘。
func ensureHomeBeaconToken() (string, homeBeaconState) {
	homeBeaconMu.Lock()
	defer homeBeaconMu.Unlock()
	state := loadHomeBeaconState()
	if state.Token == "" {
		state.Token = newHomeBeaconToken()
		_ = saveHomeBeaconState(state)
	}
	return state.Token, state
}

// recordHomeBeacon 记录一次心跳。sourceIP 为请求来源 IP，reportedIP 为上报方自称的出口 IP（可空）。
func recordHomeBeacon(sourceIP, reportedIP, source string) homeBeaconState {
	homeBeaconMu.Lock()
	defer homeBeaconMu.Unlock()

	state := loadHomeBeaconState()
	if state.Token == "" {
		state.Token = newHomeBeaconToken()
	}

	now := time.Now()
	seen := map[string]bool{}
	candidates := make([]string, 0, 2)
	for _, candidate := range []string{reportedIP, sourceIP} {
		ip := normalizeIPString(candidate)
		if ip == "" || seen[ip] {
			continue
		}
		seen[ip] = true
		candidates = append(candidates, ip)
	}

	for _, ip := range candidates {
		updated := false
		for i := range state.Records {
			if state.Records[i].IP == ip {
				state.Records[i].At = now
				state.Records[i].Source = source
				updated = true
				break
			}
		}
		if !updated {
			state.Records = append(state.Records, homeBeaconRecord{IP: ip, At: now, Source: source})
		}
	}

	sort.SliceStable(state.Records, func(i, j int) bool {
		return state.Records[i].At.After(state.Records[j].At)
	})
	if len(state.Records) > homeBeaconMaxRecords {
		state.Records = state.Records[:homeBeaconMaxRecords]
	}

	if err := saveHomeBeaconState(state); err != nil {
		log.Printf("[HomeBeacon] 保存失败: %v", err)
	}
	return state
}

func validHomeBeaconToken(candidate string) bool {
	candidate = strings.TrimSpace(candidate)
	if candidate == "" {
		return false
	}
	token, _ := ensureHomeBeaconToken()
	return token != "" && candidate == token
}

// homeBeaconMatch 判断客户端 IP 是否属于「家庭网络」。
//
// 精确命中优先；开启 PrefixMatch 时，同 /24 也算命中（CGNAT 池内漂移）。
// 已过期的记录不参与匹配。
func homeBeaconMatch(clientIP string) (bool, string) {
	ip := normalizeIPString(clientIP)
	if ip == "" {
		return false, ""
	}
	homeBeaconMu.Lock()
	state := loadHomeBeaconState()
	homeBeaconMu.Unlock()

	now := time.Now()
	fresh := make([]homeBeaconRecord, 0, len(state.Records))
	for _, record := range state.Records {
		if now.Sub(record.At) <= homeBeaconMatchTTL {
			fresh = append(fresh, record)
		}
	}
	if len(fresh) == 0 {
		return false, ""
	}
	for _, record := range fresh {
		if record.IP == ip {
			return true, record.IP
		}
	}
	if state.PrefixMatch {
		prefix := ipv4Prefix24(ip)
		if prefix != "" {
			for _, record := range fresh {
				if ipv4Prefix24(record.IP) == prefix {
					return true, record.IP
				}
			}
		}
	}
	return false, ""
}

// ipv4Prefix24 返回 IPv4 的 /24 前缀（形如 "1.2.3."），非 IPv4 返回空串。
func ipv4Prefix24(raw string) string {
	ip := net.ParseIP(strings.TrimSpace(raw))
	if ip == nil {
		return ""
	}
	v4 := ip.To4()
	if v4 == nil {
		return ""
	}
	return fmt.Sprintf("%d.%d.%d.", v4[0], v4[1], v4[2])
}

// HomeBeaconPing 心跳入口（公开，用 token 鉴权）。
//
// 在家任意一台 24h 设备上定时执行即可：
//
//	curl -fsS "https://你的域名/api/home-beacon/ping?token=xxx"
//
// 也兼容 Lucky 的 STUN webhook：POST JSON {"ip":"...","port":1234,"stun":"success"}，
// 此时优先采信上报的 ip。
func HomeBeaconPing(c *gin.Context) {
	token := c.Query("token")
	if token == "" {
		token = c.GetHeader("X-FlatNas-Beacon-Token")
	}
	if !validHomeBeaconToken(token) {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "error": "invalid token"})
		return
	}

	var body struct {
		IP   string `json:"ip"`
		Stun string `json:"stun"`
	}
	_ = c.ShouldBindJSON(&body)

	sourceIP, source := extractClientIP(c.Request)
	recordHomeBeacon(sourceIP, body.IP, source)

	recorded := normalizeIPString(body.IP)
	if recorded == "" {
		recorded = normalizeIPString(sourceIP)
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"ip":      recorded,
		"source":  source,
		"at":      time.Now().Format(time.RFC3339),
	})
}

// HomeBeaconMatch 轻量判定接口（公开）：只回一个布尔值。
//
// 前端在用过本地缓存（IP/归属地缓存 1 小时）之后会再单独问一次这里。
// 不能把「是否在家」跟着缓存一起存到浏览器里 —— 同一台设备从家里走到外面时，
// 缓存会让它继续以为在家，恰好就是这个功能要避免的误判。
func HomeBeaconMatch(c *gin.Context) {
	clientIP, source := extractClientIP(c.Request)
	match := false
	if source == "header" {
		match, _ = homeBeaconMatch(clientIP)
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "match": match})
}

func homeBeaconInfoPayload(state homeBeaconState) gin.H {
	return gin.H{
		"token":       state.Token,
		"prefixMatch": state.PrefixMatch,
		"records":     state.Records,
		"updatedAt":   state.UpdatedAt,
	}
}

// GetHomeBeaconInfo 返回心跳配置（需登录），供设置页展示「心跳地址」与状态。
func GetHomeBeaconInfo(c *gin.Context) {
	_, state := ensureHomeBeaconToken()
	c.JSON(http.StatusOK, gin.H{"success": true, "data": homeBeaconInfoPayload(state)})
}

// UpdateHomeBeaconConfig 修改心跳配置（需登录）：重新生成 token / 开关同网段匹配 / 清空记录。
func UpdateHomeBeaconConfig(c *gin.Context) {
	var body struct {
		PrefixMatch     *bool `json:"prefixMatch"`
		RegenerateToken bool  `json:"regenerateToken"`
		Clear           bool  `json:"clear"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "error": "invalid body"})
		return
	}

	homeBeaconMu.Lock()
	state := loadHomeBeaconState()
	if state.Token == "" {
		state.Token = newHomeBeaconToken()
	}
	if body.RegenerateToken {
		state.Token = newHomeBeaconToken()
	}
	if body.PrefixMatch != nil {
		state.PrefixMatch = *body.PrefixMatch
	}
	if body.Clear {
		state.Records = nil
	}
	err := saveHomeBeaconState(state)
	homeBeaconMu.Unlock()

	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": homeBeaconInfoPayload(state)})
}
