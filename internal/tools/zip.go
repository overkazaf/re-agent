package tools

import "archive/zip"

// zipEntriesNative lists an archive without shelling out, which keeps
// apk_inspect useful on hosts that have neither unzip nor zipinfo.
func zipEntriesNative(target string) ([]string, error) {
	reader, err := zip.OpenReader(target)
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	out := make([]string, 0, len(reader.File))
	for _, file := range reader.File {
		out = append(out, file.Name)
	}
	return out, nil
}
