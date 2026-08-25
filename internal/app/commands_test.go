package app

import (
	"strings"
	"testing"

	"github.com/overkazaf/re-agent/internal/config"
	"github.com/overkazaf/re-agent/internal/remote"
	"github.com/overkazaf/re-agent/internal/types"
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

func TestRemoteOffClearsTheExecutionTarget(t *testing.T) {
	t.Setenv("OXAF_REMOTE_DIR", t.TempDir())
	store, err := remote.LoadFrom(t.TempDir() + "/remote.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Add(remote.Host{Name: "lab", Host: "10.0.0.5", User: "dev"}); err != nil {
		t.Fatal(err)
	}
	state := &State{
		RemoteStore: store,
		Remote:      remote.NewManager(store),
		ToolContext: &types.ToolContext{},
	}
	state.ToolContext.RemoteHost = "lab"
	store.SetCurrent("lab")

	// Both spellings must turn remote mode off.
	for _, command := range []string{"off", "use off"} {
		if err := handleRemoteCommand(command, state); err != nil {
			t.Fatalf("/remote %s: %v", command, err)
		}
		if state.ToolContext.RemoteHost != "" {
			t.Fatalf("/remote %s did not clear RemoteHost", command)
		}
		if store.Current() != "" {
			t.Fatalf("/remote %s did not clear the store current host", command)
		}
		state.ToolContext.RemoteHost = "lab"
		store.SetCurrent("lab")
	}
}
