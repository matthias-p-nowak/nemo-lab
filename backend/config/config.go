package config

import "github.com/BurntSushi/toml"

const (
	defaultListenAddr  = ":7033"
	defaultStaticDir   = "dist"
	defaultDBPath      = "nemo.db"
	defaultLogsDir     = "logs"
	defaultCacheDir    = "/tmp/nemo-lab/cache"
	defaultCacheMB     = int64(512)
	defaultCacheEvict  = "5m"
	defaultTileWorkers = 4
)

// Config contains runtime configuration loaded from TOML.
type Config struct {
	ListenAddr         string   `toml:"listen_addr"`
	StaticDir          string   `toml:"static_dir"`
	DBPath             string   `toml:"db_path"`
	LogsDir            string   `toml:"logs_dir"`
	Admins             []string `toml:"admins"`
	CacheDir           string   `toml:"cache_dir"`
	CacheLimitMB       int64    `toml:"cache_limit_mb"`
	CacheEvictInterval string   `toml:"cache_evict_interval"`
	TileWorkers        int      `toml:"tile_workers"`
}

// Load reads a TOML config file and applies defaults.
func Load(path string) (*Config, error) {
	cfg := &Config{
		ListenAddr:         defaultListenAddr,
		StaticDir:          defaultStaticDir,
		DBPath:             defaultDBPath,
		LogsDir:            defaultLogsDir,
		Admins:             []string{},
		CacheDir:           defaultCacheDir,
		CacheLimitMB:       defaultCacheMB,
		CacheEvictInterval: defaultCacheEvict,
		TileWorkers:        defaultTileWorkers,
	}

	if _, err := toml.DecodeFile(path, cfg); err != nil {
		return nil, err
	}

	if cfg.ListenAddr == "" {
		cfg.ListenAddr = defaultListenAddr
	}
	if cfg.StaticDir == "" {
		cfg.StaticDir = defaultStaticDir
	}
	if cfg.DBPath == "" {
		cfg.DBPath = defaultDBPath
	}
	if cfg.LogsDir == "" {
		cfg.LogsDir = defaultLogsDir
	}
	if cfg.Admins == nil {
		cfg.Admins = []string{}
	}
	if cfg.CacheDir == "" {
		cfg.CacheDir = defaultCacheDir
	}
	if cfg.CacheLimitMB <= 0 {
		cfg.CacheLimitMB = defaultCacheMB
	}
	if cfg.CacheEvictInterval == "" {
		cfg.CacheEvictInterval = defaultCacheEvict
	}
	if cfg.TileWorkers <= 0 {
		cfg.TileWorkers = defaultTileWorkers
	}

	return cfg, nil
}
