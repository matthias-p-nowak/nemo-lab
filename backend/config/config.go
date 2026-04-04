package config

import "github.com/BurntSushi/toml"

const (
	defaultListenAddr = ":7255"
	defaultStaticDir  = "dist"
	defaultDBPath     = "nemo.db"
	defaultLogsDir    = "logs"
)

// Config contains runtime configuration loaded from TOML.
type Config struct {
	ListenAddr string   `toml:"listen_addr"`
	StaticDir  string   `toml:"static_dir"`
	DBPath     string   `toml:"db_path"`
	LogsDir    string   `toml:"logs_dir"`
	Admins     []string `toml:"admins"`
}

// Load reads a TOML config file and applies defaults.
func Load(path string) (*Config, error) {
	cfg := &Config{
		ListenAddr: defaultListenAddr,
		StaticDir:  defaultStaticDir,
		DBPath:     defaultDBPath,
		LogsDir:    defaultLogsDir,
		Admins:     []string{},
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

	return cfg, nil
}
