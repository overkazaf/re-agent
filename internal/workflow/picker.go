package workflow

type SampleType struct {
	Key     string
	Label   string
	Desc    string
	Prompts []SamplePrompt
}

type SamplePrompt struct {
	Short string
	Full  string
}

func SampleTypes() []SampleType {
	return []SampleType{
		{Key: "apk", Label: "APK", Desc: "Android application package",
			Prompts: []SamplePrompt{
				{Short: "Triage APK structure", Full: "Identify package name, permissions, components, native libs, and signing info for this APK."},
				{Short: "Find hardcoded secrets", Full: "Search for hardcoded API keys, tokens, URLs, and credentials in the APK's dex and resource files."},
				{Short: "Trace native JNI calls", Full: "Map JNI bridge methods between Java/Kotlin and native .so libraries in this APK."},
				{Short: "Recover obfuscated logic", Full: "Deobfuscate and recover the core business logic from this APK's smali/dex."},
			}},
		{Key: "so", Label: "SO / ELF shared lib", Desc: "Linux/Android shared object",
			Prompts: []SamplePrompt{
				{Short: "Symbol & import survey", Full: "List exported/imported symbols, detect stripping level, and identify key routines."},
				{Short: "Find crypto primitives", Full: "Locate cryptographic constants, S-boxes, and cipher implementations in this binary."},
				{Short: "Reconstruct C structs", Full: "Recover C/C++ struct layouts from field access patterns in the decompiled code."},
			}},
		{Key: "dylib", Label: "dylib / Mach-O", Desc: "macOS/iOS dynamic library",
			Prompts: []SamplePrompt{
				{Short: "Objective-C class dump", Full: "Dump Objective-C class hierarchy, selectors, and protocol conformances."},
				{Short: "Swift metadata recovery", Full: "Recover Swift type metadata, protocol witness tables, and generic signatures."},
				{Short: "Entitlements & codesign", Full: "Extract and analyze code signing info, entitlements, and provisioning profile."},
			}},
		{Key: "elf", Label: "ELF binary", Desc: "Linux executable / core dump",
			Prompts: []SamplePrompt{
				{Short: "Binary hardening check", Full: "Check RELRO, stack canary, NX, PIE, FORTIFY, and RPATH/RUNPATH settings."},
				{Short: "Vulnerability surface", Full: "Identify dangerous function calls (gets, strcpy, system) and potential overflow points."},
				{Short: "Control flow recovery", Full: "Recover the main control flow graph and identify key decision points."},
			}},
		{Key: "pe", Label: "PE / DLL", Desc: "Windows executable or library",
			Prompts: []SamplePrompt{
				{Short: "Import table analysis", Full: "Analyze IAT/EAT, identify suspicious API imports (VirtualAlloc, CreateRemoteThread, etc)."},
				{Short: "Packer/protector detect", Full: "Detect packing, encryption, or obfuscation layers (UPX, VMProtect, Themida, etc)."},
				{Short: "Resource extraction", Full: "Extract embedded resources, version info, manifests, and suspicious payloads."},
			}},
		{Key: "firmware", Label: "Firmware blob", Desc: "Embedded / IoT firmware image",
			Prompts: []SamplePrompt{
				{Short: "Firmware survey", Full: "Identify base address, architecture, filesystem layout, and embedded OS."},
				{Short: "Extract filesystem", Full: "Carve and extract the filesystem image, then inventory key binaries and configs."},
				{Short: "Find hardcoded creds", Full: "Search for default passwords, private keys, certificates, and debug backdoors."},
			}},
		{Key: "pcap", Label: "PCAP / traffic", Desc: "Network capture file",
			Prompts: []SamplePrompt{
				{Short: "Protocol identification", Full: "Identify protocols, session flows, and extract notable payloads from this capture."},
				{Short: "C2 traffic analysis", Full: "Look for C2 beaconing patterns, DNS tunneling, or suspicious periodic connections."},
			}},
	}
}

func SampleTypeByKey(key string) *SampleType {
	for _, st := range SampleTypes() {
		if st.Key == key {
			return &st
		}
	}
	return nil
}
