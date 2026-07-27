---
name: unidbg
description: Build and debug Android native-code emulators with unidbg. Use for APK/SO JNI loading, native function calls, signature cracking, crypto algorithm extraction, Android environment mocking, hooks, traces, and anti-debug/root bypass in authorized reverse-engineering tasks.
tags: android so jni unidbg native emulate signature crypto hook apk
---

# Unidbg Development

Use unidbg when a target Android `.so` needs Java/JNI context, Android framework values, dependent libraries, file-system mocks, or realistic native execution. Use `unicorn-emulator` instead for small isolated instruction ranges with no Java/JNI dependencies.

## Agent Workflow

1. Gather evidence before writing Java:
   - APK/package/class/method from `jadx` or `apk_inspect`.
   - ABI and target library path: `armeabi-v7a` -> `for32Bit()`, `arm64-v8a` -> `for64Bit()`.
   - JNI method signature from decompiled Java, smali, or `javap`-style descriptors.
   - Native exports and offsets from `extract_symbols`, `nm -D`, or `radare2-reverse`.
2. Build the smallest harness that loads the APK/SO, calls `JNI_OnLoad`, resolves the target class, and invokes one method.
3. Turn on `vm.setVerbose(true)` for the first run. Add only the missing JNI callbacks shown by the failure log.
4. Stabilize Android state: package name, Build fields, Android ID, files under `/proc`, and app data paths.
5. Add hooks/traces only around the suspected function or dependency. Wide instruction tracing is expensive.
6. Run known input/output test vectors. Report exact class, JNI signature, library, ABI, offsets, mocks, and remaining missing callbacks.

## Minimal Project

Use Maven or Gradle already present in the repo when possible. If creating a throwaway harness, keep it local to the case directory.

```xml
<dependencies>
  <dependency>
    <groupId>com.github.zhkl0228</groupId>
    <artifactId>unidbg-android</artifactId>
    <version>0.9.7</version>
  </dependency>
  <dependency>
    <groupId>com.github.zhkl0228</groupId>
    <artifactId>unidbg-api</artifactId>
    <version>0.9.7</version>
  </dependency>
  <dependency>
    <groupId>commons-logging</groupId>
    <artifactId>commons-logging</artifactId>
    <version>1.2</version>
  </dependency>
</dependencies>
<repositories>
  <repository>
    <id>jitpack.io</id>
    <url>https://jitpack.io</url>
  </repository>
</repositories>
```

Expected layout:

```text
case/
├── pom.xml
├── apk/target.apk
├── lib/armeabi-v7a/libtarget.so
├── lib/arm64-v8a/libtarget.so
└── src/main/java/recase/Demo.java
```

## Minimal Harness

```java
package recase;

import com.github.unidbg.AndroidEmulator;
import com.github.unidbg.Emulator;
import com.github.unidbg.Module;
import com.github.unidbg.linux.android.AndroidEmulatorBuilder;
import com.github.unidbg.linux.android.AndroidResolver;
import com.github.unidbg.linux.android.dvm.AbstractJni;
import com.github.unidbg.linux.android.dvm.BaseVM;
import com.github.unidbg.linux.android.dvm.ByteArray;
import com.github.unidbg.linux.android.dvm.DalvikModule;
import com.github.unidbg.linux.android.dvm.DvmClass;
import com.github.unidbg.linux.android.dvm.DvmObject;
import com.github.unidbg.linux.android.dvm.StringObject;
import com.github.unidbg.linux.android.dvm.VM;
import com.github.unidbg.linux.android.dvm.VarArg;
import com.github.unidbg.memory.Memory;

import java.io.File;
import java.io.IOException;

public class Demo extends AbstractJni {
    private final AndroidEmulator emulator;
    private final VM vm;
    private final Module module;
    private final DvmClass targetClass;

    public Demo() {
        boolean is64 = false; // set from ABI evidence, not guesswork
        emulator = (is64 ? AndroidEmulatorBuilder.for64Bit() : AndroidEmulatorBuilder.for32Bit())
                .setProcessName("com.example.app")
                .build();

        Memory memory = emulator.getMemory();
        memory.setLibraryResolver(new AndroidResolver(23));

        vm = emulator.createDalvikVM(new File("apk/target.apk"));
        vm.setJni(this);
        vm.setVerbose(true);

        DalvikModule dm = vm.loadLibrary(new File("lib/armeabi-v7a/libtarget.so"), true);
        module = dm.getModule();
        dm.callJNI_OnLoad(emulator);

        targetClass = vm.resolveClass("com/example/app/NativeApi");
    }

    public String callSign(String input, long timestamp) {
        DvmObject<?> result = targetClass.callStaticJniMethodObject(
                emulator,
                "sign(Ljava/lang/String;J)Ljava/lang/String;",
                vm.addLocalObject(new StringObject(vm, input)),
                timestamp
        );
        return result == null ? null : String.valueOf(result.getValue());
    }

    public byte[] callEncrypt(byte[] data) {
        DvmObject<?> result = targetClass.callStaticJniMethodObject(
                emulator,
                "encrypt([B)[B",
                vm.addLocalObject(new ByteArray(vm, data))
        );
        return result == null ? null : (byte[]) result.getValue();
    }

    public Number callExport(String symbol, Object... args) {
        com.github.unidbg.Symbol s = module.findSymbolByName(symbol);
        if (s == null) {
            throw new IllegalStateException("missing symbol: " + symbol);
        }
        return s.call(emulator, args)[0];
    }

    public Number callOffset(long offset, Object... args) {
        return module.callFunction(emulator, offset, args)[0];
    }

    public void close() throws IOException {
        emulator.close();
    }

    public static void main(String[] args) throws Exception {
        Demo demo = new Demo();
        System.out.println(demo.callSign("hello", 1700000000L));
        demo.close();
    }
}
```

## JNI Callback Loop

Start with verbose logging and add one callback at a time. Prefer returning stable fake values that match the real app shape.

```java
@Override
public DvmObject<?> callObjectMethod(BaseVM vm, DvmObject<?> obj, String sig, VarArg args) {
    System.err.println("[JNI] callObjectMethod " + sig);
    switch (sig) {
        case "android/content/Context->getPackageName()Ljava/lang/String;":
            return new StringObject(vm, "com.example.app");
        case "java/lang/String->getBytes()[B":
            return new ByteArray(vm, String.valueOf(obj.getValue()).getBytes());
        case "java/lang/String->getBytes(Ljava/lang/String;)[B":
            return new ByteArray(vm, String.valueOf(obj.getValue()).getBytes());
        default:
            return super.callObjectMethod(vm, obj, sig, args);
    }
}

@Override
public DvmObject<?> callStaticObjectMethod(BaseVM vm, DvmClass cls, String sig, VarArg args) {
    System.err.println("[JNI] callStaticObjectMethod " + sig);
    switch (sig) {
        case "java/lang/System->getProperty(Ljava/lang/String;)Ljava/lang/String;":
            return new StringObject(vm, "Linux");
        case "android/provider/Settings$Secure->getString(Landroid/content/ContentResolver;Ljava/lang/String;)Ljava/lang/String;":
            return new StringObject(vm, "a1b2c3d4e5f67890");
        default:
            return super.callStaticObjectMethod(vm, cls, sig, args);
    }
}

@Override
public DvmObject<?> getStaticObjectField(BaseVM vm, DvmClass cls, String sig) {
    switch (sig) {
        case "android/os/Build->BRAND:Ljava/lang/String;":
            return new StringObject(vm, "samsung");
        case "android/os/Build->MODEL:Ljava/lang/String;":
            return new StringObject(vm, "SM-G9880");
        case "android/os/Build->FINGERPRINT:Ljava/lang/String;":
            return new StringObject(vm, "samsung/device/release-keys");
        default:
            return super.getStaticObjectField(vm, cls, sig);
    }
}

@Override
public int getStaticIntField(BaseVM vm, DvmClass cls, String sig) {
    if ("android/os/Build$VERSION->SDK_INT:I".equals(sig)) {
        return 29;
    }
    return super.getStaticIntField(vm, cls, sig);
}

@Override
public boolean callStaticBooleanMethod(BaseVM vm, DvmClass cls, String sig, VarArg args) {
    if ("android/os/Debug->isDebuggerConnected()Z".equals(sig)) {
        return false;
    }
    return super.callStaticBooleanMethod(vm, cls, sig, args);
}
```

Common signatures to recognize:

```text
android/content/Context->getPackageName()Ljava/lang/String;
android/content/Context->getApplicationContext()Landroid/content/Context;
android/content/Context->getFilesDir()Ljava/io/File;
android/content/Context->getPackageManager()Landroid/content/pm/PackageManager;
android/provider/Settings$Secure->getString(Landroid/content/ContentResolver;Ljava/lang/String;)Ljava/lang/String;
android/os/Build->MODEL:Ljava/lang/String;
android/os/Build$VERSION->SDK_INT:I
java/lang/String->getBytes()[B
java/lang/String->getBytes(Ljava/lang/String;)[B
```

## Hooks And Tracing

Use narrow hooks first:

```java
// Break near a known offset from radare2/nm.
emulator.attach().addBreakPoint(module.base + 0x1234);

// Trace only the target range.
emulator.traceCode(module.base + 0x1200, module.base + 0x1300);

// Dump memory touched by the function.
byte[] data = emulator.getBackend().mem_read(module.base + 0x4000, 0x100);
com.github.unidbg.utils.Inspector.inspect(data, "target data");
```

HookZz wrapper pattern:

```java
import com.github.unidbg.hook.hookzz.HookEntryInfo;
import com.github.unidbg.hook.hookzz.HookZz;
import com.github.unidbg.hook.hookzz.WrapCallback;
import com.github.unidbg.arm.context.RegisterContext;

HookZz hookZz = HookZz.getInstance(emulator);
hookZz.wrap(module.findSymbolByName("strlen"), new WrapCallback<RegisterContext>() {
    @Override
    public void preCall(Emulator<?> emulator, RegisterContext ctx, HookEntryInfo info) {
        System.out.println("strlen arg0=" + ctx.getPointerArg(0).getString(0));
    }
});
```

## File-System And Anti-Debug Mocks

When the SO reads `/proc`, package files, or device files, add an `IOResolver` and return deterministic content. Keep mocks minimal and document every path.

```java
// Typical values to fake when needed:
// /proc/self/status -> "TracerPid:\t0\n"
// /proc/self/maps   -> omit frida/xposed/debugger markers
// /data/data/<pkg>/files/* -> case-local fixtures
```

For root/debug checks, common stable returns are:

```text
android/os/Debug->isDebuggerConnected()Z => false
TracerPid => 0
Build.TAGS => release-keys
ro.debuggable => 0
```

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| `UnsupportedOperationException` | Missing JNI callback | Enable verbose logs and implement the exact signature |
| `Backend does not support` | ABI mismatch | Match `for32Bit()`/`for64Bit()` to the SO directory |
| `Symbol not found` | Stripped or hidden function | Use JNI signature, export list, or `module.base + offset` |
| `dlopen failed` | Missing dependency | Load dependencies before the target SO |
| Crash after `JNI_OnLoad` | Missing Android state | Add Build, package, file, or system property mocks |
| Bad output but no crash | Wrong input shape | Recheck Java descriptor, byte/string encoding, timestamp, and locale |

## Output Checklist

Always report:

- APK/package and target class.
- SO name, ABI, base address, symbol or offset.
- JNI descriptor and exact test input.
- Added mocks/hooks and why they were needed.
- Observed output, trace evidence, and remaining unknown callbacks.
