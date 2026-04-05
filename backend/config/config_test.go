package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadAppliesTileCacheDefaults(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nemo.toml")
	if err := os.WriteFile(path, []byte(""), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	if cfg.CacheDir != defaultCacheDir {
		t.Fatalf("unexpected cache dir: %q", cfg.CacheDir)
	}
	if cfg.CacheLimitMB != defaultCacheMB {
		t.Fatalf("unexpected cache_limit_mb: %d", cfg.CacheLimitMB)
	}
	if cfg.CacheEvictInterval != defaultCacheEvict {
		t.Fatalf("unexpected cache_evict_interval: %q", cfg.CacheEvictInterval)
	}
}
