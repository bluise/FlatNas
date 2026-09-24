//go:build !windows

package utils

import (
	"os"
	"syscall"
	"time"
)

// AcquireFileLock 获取跨进程的排他文件锁（flock）。
//
// 用途：多副本部署（同一份 data 目录挂给多个进程）时，串行化对同一个文件的
// "读-改-写"。进程内的 sync.Mutex 在这种场景下完全不起作用。
//
// 锁加在独立的 <path>.lock 文件上：数据文件本身是 temp + rename 写入的，
// 直接锁数据文件会随 rename 失效。
//
// 返回的 release 必须调用（即使出错也要判空）。超时返回 ErrFileLockTimeout，
// 调用方应退化为进程内锁而不是让请求永久阻塞。
func AcquireFileLock(path string, timeout time.Duration) (func(), error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0644)
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(timeout)
	for {
		err = syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			break
		}
		if err != syscall.EWOULDBLOCK {
			_ = file.Close()
			return nil, err
		}
		if time.Now().After(deadline) {
			_ = file.Close()
			return nil, ErrFileLockTimeout
		}
		time.Sleep(20 * time.Millisecond)
	}
	return func() {
		_ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
		_ = file.Close()
	}, nil
}
