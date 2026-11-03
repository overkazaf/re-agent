package main

import (
	"context"
	"embed"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	app := NewApp()
	err := wails.Run(&options.App{
		Title:     "0xAF·RE :: COMMAND CENTER",
		Width:     1440,
		Height:    900,
		MinWidth:  1100,
		MinHeight: 700,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 5, G: 8, B: 12, A: 255}, // #05080c — no white flash
		OnStartup:        app.startup,
		OnShutdown:       app.shutdownCtx,
		Bind:             []interface{}{app},
		Mac: &mac.Options{
			TitleBar: mac.TitleBarDefault(),
			About: &mac.AboutInfo{
				Title: "0xAF·RE",
			},
		},
	})
	if err != nil {
		println("fatal:", err.Error())
	}
}

var _ = context.Background
