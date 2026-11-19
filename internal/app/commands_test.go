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

func TestParseDecodeAndRetoolCommandsSupportExtendedArgs(t *testing.T) {
	rc4Args, err := parseDecodeCommand("rc4 secret 01020304")
	if err != nil {
		t.Fatalf("parseDecodeCommand rc4: %v", err)
	}
	if rc4Args["mode"] != "rc4" || rc4Args["key"] != "secret" || rc4Args["input"] != "01020304" {
		t.Fatalf("unexpected rc4 args: %#v", rc4Args)
	}

	b32Args, err := parseDecodeCommand("b32 MZXW6===")
	if err != nil || b32Args["mode"] != "base32" {
		t.Fatalf("unexpected base32 args: %#v, err=%v", b32Args, err)
	}

	retoolArgs, err := parseRetoolCommand("unicorn template sample.so template=jni host=127.0.0.1 port=8080")
	if err != nil {
		t.Fatalf("parseRetoolCommand: %v", err)
	}
	if retoolArgs["template"] != "jni" || retoolArgs["host"] != "127.0.0.1" || retoolArgs["port"] != 8080 {
		t.Fatalf("unexpected retool args: %#v", retoolArgs)
	}
}
