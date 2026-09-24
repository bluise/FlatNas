//go:build !windows

package utils

import (
	"path/filepath"
	"testing"
	"time"
)

func TestAcquireFileLockSerializes(t *testing.T) {
	lockPath := filepath.Join(t.TempDir(), "data.json.lock")

	release, err := AcquireFileLock(lockPath, time.Second)
	if err != nil {
		t.Fatalf("首次加锁失败: %v", err)
	}

	// 第二次加锁（同一进程、不同 fd）应等待并超时
	start := time.Now()
	secondRelease, err := AcquireFileLock(lockPath, 150*time.Millisecond)
	if err == nil {
		secondRelease()
		t.Fatal("同一文件不应能被重复加锁")
	}
	if err != ErrFileLockTimeout {
		t.Fatalf("期望 ErrFileLockTimeout，实际 %v", err)
	}
	if elapsed := time.Since(start); elapsed < 100*time.Millisecond {
		t.Fatalf("应在超时后才返回，实际耗时 %v", elapsed)
	}

	// 释放后可以重新获取
	release()
	thirdRelease, err := AcquireFileLock(lockPath, time.Second)
	if err != nil {
		t.Fatalf("释放后应能重新加锁: %v", err)
	}
	thirdRelease()
}

func TestAcquireFileLockDifferentFilesIndependent(t *testing.T) {
	dir := t.TempDir()
	releaseA, err := AcquireFileLock(filepath.Join(dir, "a.lock"), time.Second)
	if err != nil {
		t.Fatalf("加锁 a 失败: %v", err)
	}
	defer releaseA()

	releaseB, err := AcquireFileLock(filepath.Join(dir, "b.lock"), time.Second)
	if err != nil {
		t.Fatalf("不同文件之间不应互相阻塞: %v", err)
	}
	releaseB()
}
