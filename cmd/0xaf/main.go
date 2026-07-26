// Command 0xaf is the reverse engineering and CTF agent: one binary, no
// runtime, the same routing and tools as the TypeScript original.
package main

import (
	"fmt"
	"os"

	"github.com/overkazaf/re-agent/internal/app"
)

func main() {
	if err := app.Run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
}
