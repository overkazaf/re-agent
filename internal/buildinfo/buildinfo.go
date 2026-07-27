package buildinfo

import (
	"runtime/debug"
	"strings"
)

const Version = "0.1.0"

// Commit can be set by release builds with:
//
//	-ldflags "-X github.com/overkazaf/re-agent/internal/buildinfo.Commit=$(git rev-parse HEAD)"
var Commit string

type Info struct {
	Version       string
	ModuleVersion string
	Commit        string
	Modified      bool
}

func Current() Info {
	info := Info{Version: Version, Commit: strings.TrimSpace(Commit)}
	if build, ok := debug.ReadBuildInfo(); ok {
		info.ModuleVersion = build.Main.Version
		for _, setting := range build.Settings {
			switch setting.Key {
			case "vcs.revision":
				if info.Commit == "" {
					info.Commit = strings.TrimSpace(setting.Value)
				}
			case "vcs.modified":
				info.Modified = setting.Value == "true"
			}
		}
		if info.Commit == "" {
			info.Commit = commitFromModuleVersion(info.ModuleVersion)
		}
	}
	return info
}

func DisplayVersion() string {
	info := Current()
	label := info.Version
	if commit := ShortCommit(info.Commit); commit != "" {
		label += " · " + commit
		if info.Modified {
			label += "-dirty"
		}
	}
	return label
}

func VersionReport() string {
	info := Current()
	commit := info.Commit
	if commit == "" {
		commit = "unknown"
	}
	moduleVersion := info.ModuleVersion
	if moduleVersion == "" {
		moduleVersion = "(unknown)"
	}
	modified := "false"
	if info.Modified {
		modified = "true"
	}
	return strings.Join([]string{
		"version        " + info.Version,
		"commit         " + commit,
		"module version " + moduleVersion,
		"modified       " + modified,
	}, "\n")
}

func ShortCommit(commit string) string {
	commit = strings.TrimSpace(commit)
	if len(commit) > 12 {
		return commit[:12]
	}
	return commit
}

func commitFromModuleVersion(version string) string {
	if version == "" || version == "(devel)" {
		return ""
	}
	lastDash := strings.LastIndex(version, "-")
	if lastDash < 0 || lastDash == len(version)-1 {
		return ""
	}
	suffix := version[lastDash+1:]
	if len(suffix) < 12 {
		return ""
	}
	for _, ch := range suffix {
		if !((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f')) {
			return ""
		}
	}
	return suffix
}
