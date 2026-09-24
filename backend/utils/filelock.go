package utils

import (
	"errors"
	"time"
)

// ErrFileLockTimeout 获取跨进程文件锁超时。
var ErrFileLockTimeout = errors.New("file lock timeout")

// FileLockTimeout 跨进程文件锁的默认等待上限。
// 超时后调用方应退化为进程内锁，避免请求被无限期挂住。
const FileLockTimeout = 10 * time.Second
