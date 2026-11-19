// Package reagent exposes the repository's embedded prompt and skill assets
// from the module root so internal packages never maintain duplicate trees.
package reagent

import "embed"

//go:embed prompts skills
var EmbeddedFS embed.FS
