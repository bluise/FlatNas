package handlers

import (
	"encoding/json"
	"flatnasgo-backend/config"
	"flatnasgo-backend/utils"
	"fmt"
	"io"
	"log"
	stdnet "net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"sort"

	"github.com/gin-gonic/gin"
	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/host"
	"github.com/shirou/gopsutil/v3/mem"
	"github.com/shirou/gopsutil/v3/net"
)

type NetworkStat struct {
	Iface string `json:"iface"`
	RxSec uint64 `json:"rx_sec"`
	TxSec uint64 `json:"tx_sec"`
}

var (
	lastNetStats        []net.IOCountersStat
	lastNetTime         time.Time
	lastCalculatedRates []NetworkStat
	netMutex            sync.Mutex

	lastCPUTimes []cpu.TimesStat
	lastCPUTime  time.Time
	cpuMutex     sync.Mutex

	systemStatsCache      gin.H
	systemStatsCacheMu    sync.RWMutex
	systemStatsLastUpdate time.Time
	systemStatsTTL        = 3 * time.Second
)

func calculateTotalTime(t cpu.TimesStat) float64 {
	return t.User + t.System + t.Idle + t.Nice + t.Iowait + t.Irq + t.Softirq + t.Steal + t.Guest + t.GuestNice
}

func GetSystemStats(c *gin.Context) {
	systemStatsCacheMu.RLock()
	if systemStatsCache != nil && time.Since(systemStatsLastUpdate) < systemStatsTTL {
		data := systemStatsCache
		systemStatsCacheMu.RUnlock()
		c.JSON(http.StatusOK, gin.H{"success": true, "data": data})
		return
	}
	systemStatsCacheMu.RUnlock()

	systemStatsCacheMu.Lock()
	defer systemStatsCacheMu.Unlock()

	if systemStatsCache != nil && time.Since(systemStatsLastUpdate) < systemStatsTTL {
		c.JSON(http.StatusOK, gin.H{"success": true, "data": systemStatsCache})
		return
	}

	data := collectSystemStats()
	systemStatsCache = data
	systemStatsLastUpdate = time.Now()

	c.JSON(http.StatusOK, gin.H{"success": true, "data": data})
}

func collectSystemStats() gin.H {
	v, _ := mem.VirtualMemory()
	cStats, _ := cpu.Info()

	currentTimes, _ := cpu.Times(false)
	var currentLoad, currentLoadUser, currentLoadSystem float64

	cpuMutex.Lock()
	if len(currentTimes) > 0 {
		now := time.Now()
		if !lastCPUTime.IsZero() && len(lastCPUTimes) > 0 {
			deltaTotal := calculateTotalTime(currentTimes[0]) - calculateTotalTime(lastCPUTimes[0])
			if deltaTotal > 0 {
				currentLoadUser = (currentTimes[0].User - lastCPUTimes[0].User) / deltaTotal * 100
				currentLoadSystem = (currentTimes[0].System - lastCPUTimes[0].System) / deltaTotal * 100
				currentLoad = 100 - ((currentTimes[0].Idle - lastCPUTimes[0].Idle) / deltaTotal * 100)
			}
		}
		lastCPUTimes = currentTimes
		lastCPUTime = now
	}
	cpuMutex.Unlock()

	volume := filepath.VolumeName(config.BaseDir)
	if volume == "" {
		volume = "/"
	} else {
		volume = volume + "\\"
	}
	d, _ := disk.Usage(volume)

	currentNet, _ := net.IOCounters(true)
	now := time.Now()

	netMutex.Lock()
	var networkStats []NetworkStat

	duration := now.Sub(lastNetTime).Seconds()

	if lastNetTime.IsZero() || duration < 1.0 {
		if lastCalculatedRates == nil {
			for _, n := range currentNet {
				networkStats = append(networkStats, NetworkStat{
					Iface: n.Name,
					RxSec: 0,
					TxSec: 0,
				})
			}
			lastNetStats = currentNet
			lastNetTime = now
			lastCalculatedRates = networkStats
		} else {
			networkStats = lastCalculatedRates
		}
	} else {
		currMap := make(map[string]net.IOCountersStat)
		for _, n := range currentNet {
			currMap[n.Name] = n
		}

		lastMap := make(map[string]net.IOCountersStat)
		for _, n := range lastNetStats {
			lastMap[n.Name] = n
		}

		for _, curr := range currentNet {
			rxSec := uint64(0)
			txSec := uint64(0)

			if last, ok := lastMap[curr.Name]; ok {
				if curr.BytesRecv >= last.BytesRecv {
					rxSec = uint64(float64(curr.BytesRecv-last.BytesRecv) / duration)
				}
				if curr.BytesSent >= last.BytesSent {
					txSec = uint64(float64(curr.BytesSent-last.BytesSent) / duration)
				}
			}

			networkStats = append(networkStats, NetworkStat{
				Iface: curr.Name,
				RxSec: rxSec,
				TxSec: txSec,
			})
		}

		lastNetStats = currentNet
		lastNetTime = now
		lastCalculatedRates = networkStats
	}
	netMutex.Unlock()

	sort.Slice(networkStats, func(i, j int) bool {
		return networkStats[i].Iface < networkStats[j].Iface
	})

	h, _ := host.Info()

	brand := "Unknown"
	manufacturer := "Unknown"
	speed := 0.0
	if len(cStats) > 0 {
		brand = cStats[0].ModelName
		manufacturer = cStats[0].VendorID
		speed = cStats[0].Mhz / 1000.0
	}

	return gin.H{
		"cpu": gin.H{
			"currentLoad":       currentLoad,
			"currentLoadUser":   currentLoadUser,
			"currentLoadSystem": currentLoadSystem,
			"cores":             runtime.NumCPU(),
			"brand":             brand,
			"manufacturer":      manufacturer,
			"speed":             speed,
		},
		"mem": gin.H{
			"total":     v.Total,
			"used":      v.Used,
			"active":    v.Active,
			"available": v.Available,
		},
		"disk": []gin.H{
			{
				"fs":    d.Fstype,
				"type":  "Fixed",
				"size":  d.Total,
				"used":  d.Used,
				"use":   d.UsedPercent,
				"mount": d.Path,
			},
		},
		"network": networkStats,
		"os": gin.H{
			"distro":   h.Platform,
			"release":  h.PlatformVersion,
			"hostname": h.Hostname,
			"arch":     h.KernelArch,
		},
		"uptime": h.Uptime,
	}
}

func GetCustomScripts(c *gin.Context) {
	username := c.GetString("username")
	if username == "" {
		c.JSON(http.StatusOK, gin.H{
			"success": true,
			"css":     []interface{}{},
			"js":      []interface{}{},
		})
		return
	}
	path := filepath.Join(config.DataDir, "custom_scripts.json")
	payload := CustomScriptsPayload{
		CSS: []interface{}{},
		JS:  []interface{}{},
	}
	var data map[string]CustomScriptsPayload
	if err := utils.ReadJSON(path, &data); err == nil {
		if entry, ok := data[username]; ok {
			payload = entry
			if payload.CSS == nil {
				payload.CSS = []interface{}{}
			}
			if payload.JS == nil {
				payload.JS = []interface{}{}
			}
		}
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"css":     payload.CSS,
		"js":      payload.JS,
	})
}

type CustomScriptsPayload struct {
	CSS []interface{} `json:"css"`
	JS  []interface{} `json:"js"`
}

func SaveCustomScripts(c *gin.Context) {
	username := c.GetString("username")
	if username == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Unauthorized"})
		return
	}
	var payload CustomScriptsPayload
	if err := c.ShouldBindJSON(&payload); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid JSON"})
		return
	}
	if payload.CSS == nil {
		payload.CSS = []interface{}{}
	}
	if payload.JS == nil {
		payload.JS = []interface{}{}
	}
	path := filepath.Join(config.DataDir, "custom_scripts.json")
	var data map[string]CustomScriptsPayload
	if err := utils.ReadJSON(path, &data); err != nil || data == nil {
		data = make(map[string]CustomScriptsPayload)
	}
	data[username] = payload
	if err := utils.WriteJSON(path, data); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save custom scripts"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// IPCache holds the cached public IP information
type IPCache struct {
	IP       string
	Location string
	Country  string
	Region   string
	City     string
	Updated  time.Time
	Mutex    sync.RWMutex
}

// IPInfo is a unified struct for IP provider responses
type IPInfo struct {
	IP      string
	City    string
	Region  string
	Country string
	Isp     string
}

var globalIPCache IPCache
var isFetchingIP int32

// StartIPFetcher starts a background goroutine to fetch public IP every 6 hours using fallback chain
func StartIPFetcher() {
	go func() {
		fetchIPAndCache()
		ticker := time.NewTicker(6 * time.Hour)
		for range ticker.C {
			fetchIPAndCache()
		}
	}()
}

// fetchIPFromProvider queries a single IP provider and returns unified IPInfo
func fetchIPFromProvider(provider string) (*IPInfo, error) {
	client := http.Client{Timeout: 3 * time.Second}

	switch provider {
	case "ip-api":
		resp, err := client.Get("http://ip-api.com/json/?lang=zh-CN")
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		var result map[string]interface{}
		if err := json.Unmarshal(body, &result); err != nil {
			return nil, err
		}
		if status, ok := result["status"].(string); ok && status == "fail" {
			return nil, fmt.Errorf("ip-api: status fail")
		}
		info := &IPInfo{}
		if query, ok := result["query"].(string); ok {
			info.IP = query
		}
		if city, ok := result["city"].(string); ok {
			info.City = city
		}
		if region, ok := result["regionName"].(string); ok {
			info.Region = region
		}
		if country, ok := result["country"].(string); ok {
			info.Country = country
		}
		if isp, ok := result["isp"].(string); ok {
			info.Isp = isp
		}
		return info, nil

	case "ipwhois":
		resp, err := client.Get("http://ipwho.is/")
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		var result map[string]interface{}
		if err := json.Unmarshal(body, &result); err != nil {
			return nil, err
		}
		if success, ok := result["success"].(bool); ok && !success {
			return nil, fmt.Errorf("ipwhois: not success")
		}
		info := &IPInfo{}
		if ip, ok := result["ip"].(string); ok {
			info.IP = ip
		}
		if city, ok := result["city"].(string); ok {
			info.City = city
		}
		if region, ok := result["region"].(string); ok {
			info.Region = region
		}
		if country, ok := result["country"].(string); ok {
			info.Country = country
		}
		if isp, ok := result["connection"].(map[string]interface{}); ok {
			if org, exists := isp["org"].(string); exists {
				info.Isp = org
			}
		}
		return info, nil

	case "ipapi-co":
		resp, err := client.Get("https://ipapi.co/json/")
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		var result map[string]interface{}
		if err := json.Unmarshal(body, &result); err != nil {
			return nil, err
		}
		if reason, ok := result["reason"].(string); ok && reason != "" {
			return nil, fmt.Errorf("ipapi.co: %s", reason)
		}
		info := &IPInfo{}
		if ip, ok := result["ip"].(string); ok {
			info.IP = ip
		}
		if city, ok := result["city"].(string); ok {
			info.City = city
		}
		if region, ok := result["region"].(string); ok {
			info.Region = region
		}
		if country, ok := result["country_name"].(string); ok {
			info.Country = country
		}
		if isp, ok := result["org"].(string); ok {
			info.Isp = isp
		}
		return info, nil

	case "freeipapi":
		resp, err := client.Get("https://freeipapi.com/api/json")
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		var result map[string]interface{}
		if err := json.Unmarshal(body, &result); err != nil {
			return nil, err
		}
		info := &IPInfo{}
		if city, ok := result["cityName"].(string); ok {
			info.City = city
		}
		if region, ok := result["regionName"].(string); ok {
			info.Region = region
		}
		if country, ok := result["countryName"].(string); ok {
			info.Country = country
		}
		return info, nil

	default:
		return nil, fmt.Errorf("unknown provider: %s", provider)
	}
}

var ipProviders = []string{"ip-api", "ipwhois", "ipapi-co", "freeipapi"}

// englishToChineseCity 常见城市英文名→中文映射表（兜底转换）
var englishToChineseCity = map[string]string{
	// 浙江省
	"Ningbo":   "宁波",
	"Hangzhou": "杭州",
	"Wenzhou":  "温州",
	"Jiaxing":  "嘉兴",
	"Huzhou":   "湖州",
	"Shaoxing": "绍兴",
	"Jinhua":   "金华",
	"Quzhou":   "衢州",
	"Taizhou":  "台州",
	"Lishui":   "丽水",
	"Zhoushan": "舟山",
	// 直辖市
	"Shanghai":  "上海",
	"Beijing":   "北京",
	"Tianjin":   "天津",
	"Chongqing": "重庆",
	// 广东省
	"Guangzhou": "广州",
	"Shenzhen":  "深圳",
	"Dongguan":  "东莞",
	"Foshan":    "佛山",
	"Zhuhai":    "珠海",
	"Shantou":   "汕头",
	"Zhongshan": "中山",
	"Huizhou":   "惠州",
	"Jiangmen":  "江门",
	"Zhanjiang": "湛江",
	// 江苏省
	"Nanjing":     "南京",
	"Suzhou":      "苏州",
	"Wuxi":        "无锡",
	"Changzhou":   "常州",
	"Nantong":     "南通",
	"Yangzhou":    "扬州",
	"Xuzhou":      "徐州",
	"Yancheng":    "盐城",
	"Lianyungang": "连云港",
	// 其他主要城市
	"Chengdu":      "成都",
	"Wuhan":        "武汉",
	"Xi'an":        "西安",
	"Xian":         "西安",
	"Qingdao":      "青岛",
	"Dalian":       "大连",
	"Shenyang":     "沈阳",
	"Harbin":       "哈尔滨",
	"Changsha":     "长沙",
	"Zhengzhou":    "郑州",
	"Jinan":        "济南",
	"Hefei":        "合肥",
	"Fuzhou":       "福州",
	"Xiamen":       "厦门",
	"Kunming":      "昆明",
	"Nanning":      "南宁",
	"Guiyang":      "贵阳",
	"Urumqi":       "乌鲁木齐",
	"Lhasa":        "拉萨",
	"Hohhot":       "呼和浩特",
	"Yinchuan":     "银川",
	"Lanzhou":      "兰州",
	"Taiyuan":      "太原",
	"Shijiazhuang": "石家庄",
	"Haikou":       "海口",
	"Sanya":        "三亚",
}

// normalizeCityToChinese 将英文城市名转换为中文（如果存在映射）
func normalizeCityToChinese(city string) string {
	if city == "" {
		return ""
	}
	// 先检查是否已经在映射表中
	if zh, ok := englishToChineseCity[city]; ok {
		return zh
	}
	// 检查是否是常见的 "City, Province" 格式
	parts := strings.SplitN(city, ", ", 2)
	if len(parts) == 2 {
		if zh, ok := englishToChineseCity[parts[0]]; ok {
			return zh
		}
	}
	return city
}

func fetchIPAndCache() bool {
	if !atomic.CompareAndSwapInt32(&isFetchingIP, 0, 1) {
		return false
	}
	defer atomic.StoreInt32(&isFetchingIP, 0)

	// 优先尝试 ip-api（支持中文），失败后重试 2 次
	for attempt := 0; attempt < 3; attempt++ {
		info, err := fetchIPFromProvider("ip-api")
		if err == nil && info.City != "" {
			info.City = normalizeCityToChinese(info.City)
			saveIPInfoToCache(info, "ip-api")
			return true
		}
		if attempt < 2 {
			time.Sleep(500 * time.Millisecond)
		}
	}

	// ip-api 完全失败后，才尝试其他备用提供商
	for _, provider := range ipProviders[1:] {
		info, err := fetchIPFromProvider(provider)
		if err != nil {
			log.Printf("[IPFetcher] %s failed: %v", provider, err)
			continue
		}
		if info.City != "" {
			info.City = normalizeCityToChinese(info.City)
			saveIPInfoToCache(info, provider)
			return true
		}
	}
	log.Println("[IPFetcher] All providers failed")
	return false
}

func saveIPInfoToCache(info *IPInfo, provider string) {
	location := info.City
	if info.Region != "" {
		location = info.Region + " " + location
	}
	if info.Country != "" {
		location = info.Country + " " + location
	}
	if info.Isp != "" {
		location = location + " " + info.Isp
	}
	globalIPCache.Mutex.Lock()
	globalIPCache.IP = info.IP
	globalIPCache.City = info.City
	globalIPCache.Region = info.Region
	globalIPCache.Country = info.Country
	globalIPCache.Location = location
	globalIPCache.Updated = time.Now()
	globalIPCache.Mutex.Unlock()
	log.Printf("[IPFetcher] Success via %s: %s", provider, info.City)
}

func GetIP(c *gin.Context) {
	clientIp, clientIpSource := extractClientIP(c.Request)
	refresh := strings.TrimSpace(c.Query("refresh"))
	refreshed := false
	if refresh == "1" || strings.EqualFold(refresh, "true") {
		fetchIPAndCache()
		refreshed = true
	}

	globalIPCache.Mutex.RLock()
	ip := globalIPCache.IP
	location := globalIPCache.Location
	country := globalIPCache.Country
	region := globalIPCache.Region
	city := globalIPCache.City
	updated := globalIPCache.Updated
	globalIPCache.Mutex.RUnlock()

	// Check if cache is still valid (30 min TTL)
	cacheValid := ip != "" && time.Since(updated) < 30*time.Minute

	if cacheValid {
		c.JSON(http.StatusOK, gin.H{
			"success":        true,
			"ip":             ip,
			"location":       location,
			"country":        country,
			"region":         region,
			"city":           city,
			"queryIp":        ip,
			"clientIp":       clientIp,
			"clientIpSource": clientIpSource,
			"cached":         true,
		})
		return
	}

	// Cache expired or empty, try to fetch
	if refreshed {
		// Just tried and failed
		c.JSON(http.StatusOK, gin.H{
			"success":        false,
			"ip":             clientIp,
			"clientIp":       clientIp,
			"clientIpSource": clientIpSource,
		})
		return
	}

	// Try fetching now
	if fetchIPAndCache() {
		globalIPCache.Mutex.RLock()
		c.JSON(http.StatusOK, gin.H{
			"success":        true,
			"ip":             globalIPCache.IP,
			"location":       globalIPCache.Location,
			"country":        globalIPCache.Country,
			"region":         globalIPCache.Region,
			"city":           globalIPCache.City,
			"queryIp":        globalIPCache.IP,
			"clientIp":       clientIp,
			"clientIpSource": clientIpSource,
			"cached":         false,
		})
		globalIPCache.Mutex.RUnlock()
		return
	}

	// All failed
	c.JSON(http.StatusOK, gin.H{
		"success":        false,
		"ip":             clientIp,
		"clientIp":       clientIp,
		"clientIpSource": clientIpSource,
	})
}

func extractClientIP(r *http.Request) (string, string) {
	if r == nil {
		return "", "unknown"
	}
	headerKeys := []string{"CF-Connecting-IP", "True-Client-IP", "X-Real-IP"}
	for _, key := range headerKeys {
		if ip := normalizeIPString(r.Header.Get(key)); ip != "" {
			return ip, "header"
		}
	}
	if ip := firstXForwardedForIP(r.Header.Get("X-Forwarded-For")); ip != "" {
		return ip, "header"
	}
	if ip := normalizeIPString(r.RemoteAddr); ip != "" {
		return ip, "remoteAddr"
	}
	return "", "unknown"
}

func firstXForwardedForIP(xff string) string {
	raw := strings.TrimSpace(xff)
	if raw == "" {
		return ""
	}
	parts := strings.Split(raw, ",")
	for _, part := range parts {
		if ip := normalizeIPString(part); ip != "" {
			return ip
		}
	}
	return ""
}

func normalizeIPString(raw string) string {
	v := strings.TrimSpace(raw)
	if v == "" {
		return ""
	}
	v = strings.Trim(v, "[]")
	if host, _, err := stdnet.SplitHostPort(v); err == nil {
		v = host
	}
	v = strings.TrimSpace(strings.Trim(v, "[]"))
	ip := stdnet.ParseIP(v)
	if ip == nil {
		return ""
	}
	return ip.String()
}

func getLocationString(data map[string]interface{}) string {
	parts := []string{}
	if country, ok := data["country"].(string); ok {
		parts = append(parts, country)
	}
	if region, ok := data["regionName"].(string); ok {
		parts = append(parts, region)
	}
	if city, ok := data["city"].(string); ok {
		parts = append(parts, city)
	}
	if isp, ok := data["isp"].(string); ok {
		parts = append(parts, isp)
	}
	return strings.Join(parts, " ")
}

var pingHostnameRe = regexp.MustCompile(`^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)*$`)

// validatePingTarget 对 target 做严格校验，防止命令注入 / SSRF 异常输入。
// 允许 IPv4 / IPv6 / 合法主机名；最长 253 字符。
func validatePingTarget(target string) (string, bool) {
	target = strings.TrimSpace(target)
	if target == "" || len(target) > 253 {
		return "", false
	}
	// 优先尝试解析 IP（同时兼容 IPv6 [::1] 写法）
	if ip := stdnet.ParseIP(strings.Trim(target, "[]")); ip != nil {
		return ip.String(), true
	}
	// 主机名校验：仅允许字母/数字/连字符/点
	if pingHostnameRe.MatchString(target) {
		return target, true
	}
	return "", false
}

// pingTCPProbe 通过 TCP 探测目标常见端口（80/443/22/53），
// 任一端口握手成功即视为存活。纯 Go 实现，杜绝命令注入。
// 对内网设备友好（绝大多数 NAS/路由/服务都至少开放其中一个端口）。
func pingTCPProbe(target string, timeout time.Duration) (time.Duration, bool) {
	ports := []string{"80", "443", "22", "53"}
	type result struct {
		rtt time.Duration
		ok  bool
	}
	resultCh := make(chan result, len(ports))
	for _, p := range ports {
		go func(port string) {
			start := time.Now()
			addr := stdnet.JoinHostPort(target, port)
			conn, err := stdnet.DialTimeout("tcp", addr, timeout)
			if err != nil {
				resultCh <- result{0, false}
				return
			}
			_ = conn.Close()
			resultCh <- result{time.Since(start), true}
		}(p)
	}
	var firstRTT time.Duration
	got := false
	for i := 0; i < len(ports); i++ {
		r := <-resultCh
		if r.ok && !got {
			firstRTT = r.rtt
			got = true
		}
	}
	return firstRTT, got
}

// Ping handles latency check.
// 安全加固：
//  1. 严格校验 target，仅接受合法 IP 或主机名（防命令注入）。
//  2. 使用纯 Go net.DialTimeout 实现 TCP 连通探测，不再调用系统 ping 命令。
//  3. 配合路由层 OptionalAuth + 限流中间件防 SSRF 扫描。
func Ping(c *gin.Context) {
	raw := c.Query("target")
	if raw == "" {
		raw = "223.5.5.5"
	}
	target, ok := validatePingTarget(raw)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{
			"success": false,
			"error":   "Invalid target",
		})
		return
	}

	rtt, alive := pingTCPProbe(target, time.Second)
	if !alive {
		c.JSON(http.StatusOK, gin.H{
			"success": false,
			"error":   "Ping failed",
		})
		return
	}

	ms := rtt.Milliseconds()
	if ms <= 0 {
		c.JSON(http.StatusOK, gin.H{
			"success": true,
			"latency": "<1ms",
		})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"latency": fmt.Sprintf("%dms", ms),
	})
}

// GetMusicList returns list of music files
func GetMusicList(c *gin.Context) {
	username := c.GetString("username")
	var files []string
	assetMetaMu.Lock()
	store, metaErr := loadAssetMetaStoreUnlocked()
	if metaErr != nil {
		assetMetaMu.Unlock()
		c.JSON(http.StatusInternalServerError, []string{})
		return
	}
	err := filepath.Walk(config.MusicDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.IsDir() {
			if isSupportedMusicFile(path) {
				rel, _ := filepath.Rel(config.MusicDir, path)
				// Convert windows path separator to forward slash for web url
				rel = normalizeAssetKey(rel)
				if _, ok := store.Music[rel]; !ok {
					store.Music[rel] = assetMetaEntry{Owner: nil}
				}
				if canAccessOwnedAsset(store.Music[rel].Owner, username) {
					files = append(files, rel)
				}
			}
		}
		return nil
	})
	saveErr := saveAssetMetaStoreUnlocked(store)
	assetMetaMu.Unlock()

	if err != nil || saveErr != nil {
		c.JSON(http.StatusInternalServerError, []string{})
		return
	}

	c.JSON(http.StatusOK, files)
}

// RTT handles simple round-trip time check
func RTT(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"time":    time.Now().UnixNano(),
	})
}
