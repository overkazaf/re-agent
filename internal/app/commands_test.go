package app

import (
	"strings"
	"testing"

	"github.com/overkazaf/re-agent/internal/config"
)

func TestModelCommandRejectsWrongProviderFamily(t *testing.T) {
	state := &State{Config: config.Defaults()}
	err := handleModelCommand("executor glm-5.2", state, nil)
	if err == nil {
		t.Fatal("expected executor/claude to reject a GLM model")
	}
	if !strings.Contains(err.Error(), "/executor glm") {
		t.Fatalf("error should suggest routing to GLM provider: %v", err)
	}
}
