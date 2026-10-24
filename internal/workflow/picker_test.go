package workflow

import "testing"

func TestSampleTypes(t *testing.T) {
	types := SampleTypes()
	if len(types) < 5 {
		t.Fatalf("expected at least 5 sample types, got %d", len(types))
	}
	for _, st := range types {
		if st.Key == "" {
			t.Fatal("sample type has empty key")
		}
		if st.Label == "" {
			t.Fatalf("sample type %q has empty label", st.Key)
		}
		if len(st.Prompts) == 0 {
			t.Fatalf("sample type %q has no prompts", st.Key)
		}
		for _, p := range st.Prompts {
			if p.Short == "" || p.Full == "" {
				t.Fatalf("sample type %q has prompt with empty short or full", st.Key)
			}
		}
	}
}

func TestSampleTypeByKey(t *testing.T) {
	st := SampleTypeByKey("apk")
	if st == nil {
		t.Fatal("apk type not found")
	}
	if st.Label != "APK" {
		t.Fatalf("label = %s, want APK", st.Label)
	}
}

func TestSampleTypeByKeyNotFound(t *testing.T) {
	st := SampleTypeByKey("nonexistent")
	if st != nil {
		t.Fatal("should return nil for unknown key")
	}
}

func TestSampleTypeKeys(t *testing.T) {
	types := SampleTypes()
	keys := make(map[string]bool)
	for _, st := range types {
		if keys[st.Key] {
			t.Fatalf("duplicate key: %s", st.Key)
		}
		keys[st.Key] = true
	}
}
