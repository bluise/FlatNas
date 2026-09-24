//go:build windows

package utils

import "time"

// AcquireFileLock 在 Windows 上退化为"不加跨进程锁"。
//
// 实现跨进程加锁需要 LockFileEx（golang.org/x/sys/windows），当前未引入；
// 返回空释放函数，行为与改动前一致（仅靠进程内锁）。
func AcquireFileLock(path string, timeout time.Duration) (func(), error) {
	return func() {}, nil
}
