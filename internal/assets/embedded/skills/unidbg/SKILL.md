---
name: unidbg
description: Build and debug Android native code emulators using unidbg. Create SO file loaders, call native functions, implement hooks, handle JNI, and perform algorithm analysis. Use for reverse engineering, signature cracking, or encryption algorithm extraction.
---

# Unidbg Development Skill

A comprehensive skill for developing unidbg-based Android native code emulators, covering project setup, SO loading, function calling, hooking, and debugging.

## What is Unidbg?

Unidbg is a lightweight Android native library emulator based on Unicorn engine. It allows you to:
- Execute ARM/ARM64 native code on x86/x64 machines
- Call functions in SO files without a real Android device
- Hook and trace native function calls
- Analyze encryption algorithms and signatures
- Bypass anti-debugging and root detection

**GitHub:** https://github.com/zhkl0228/unidbg

## Project Setup

### Maven Project Structure

```
project/
├── pom.xml
├── src/
│   ├── main/
│   │   ├── java/
│   │   │   └── com/example/
│   │   │       └── Demo.java
│   │   └── resources/
│   │       └── android/
│   │           └── sdk23/
│   │               └── lib/
│   │                   ├── armeabi-v7a/
│   │                   │   └── libnative.so
│   │                   └── arm64-v8a/
│   │                       └── libnative.so
│   └── test/
│       └── java/
└── apk/
    └── target.apk
```

### pom.xml

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0
         http://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <groupId>com.example</groupId>
    <artifactId>unidbg-demo</artifactId>
    <version>1.0-SNAPSHOT</version>
    <packaging>jar</packaging>

    <properties>
        <maven.compiler.source>8</maven.compiler.source>
        <maven.compiler.target>8</maven.compiler.target>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    </properties>

    <dependencies>
        <!-- Unidbg Android -->
        <dependency>
            <groupId>com.github.zhkl0228</groupId>
            <artifactId>unidbg-android</artifactId>
            <version>0.9.7</version>
        </dependency>

        <!-- Unidbg API -->
        <dependency>
            <groupId>com.github.zhkl0228</groupId>
            <artifactId>unidbg-api</artifactId>
            <version>0.9.7</version>
        </dependency>

        <!-- Logging -->
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
</project>
```

### Gradle Alternative (build.gradle)

```groovy
plugins {
    id 'java'
}

group 'com.example'
version '1.0-SNAPSHOT'

repositories {
    mavenCentral()
    maven { url 'https://jitpack.io' }
}

dependencies {
    implementation 'com.github.zhkl0228:unidbg-android:0.9.7'
    implementation 'com.github.zhkl0228:unidbg-api:0.9.7'
    implementation 'commons-logging:commons-logging:1.2'
}
```

---

## Basic Template

### Minimal Emulator Template

```java
package com.example;

import com.github.unidbg.AndroidEmulator;
import com.github.unidbg.Module;
import com.github.unidbg.linux.android.AndroidEmulatorBuilder;
import com.github.unidbg.linux.android.AndroidResolver;
import com.github.unidbg.linux.android.dvm.*;
import com.github.unidbg.memory.Memory;

import java.io.File;
import java.io.IOException;

public class Demo extends AbstractJni {

    private final AndroidEmulator emulator;
    private final VM vm;
    private final Module module;
    private final DvmClass dvmClass;

    public Demo() {
        // 1. Create emulator instance
        emulator = AndroidEmulatorBuilder
                .for32Bit()  // or for64Bit()
                .setProcessName("com.example.app")
                .build();

        // 2. Get memory and set SDK version
        Memory memory = emulator.getMemory();
        memory.setLibraryResolver(new AndroidResolver(23));

        // 3. Create Dalvik VM
        vm = emulator.createDalvikVM(new File("apk/target.apk"));
        vm.setJni(this);
        vm.setVerbose(true);  // Print JNI calls

        // 4. Load SO library
        DalvikModule dm = vm.loadLibrary(new File("path/to/libnative.so"), true);
        module = dm.getModule();

        // 5. Call JNI_OnLoad
        dm.callJNI_OnLoad(emulator);

        // 6. Get target class
        dvmClass = vm.resolveClass("com/example/app/NativeLib");
    }

    public void destroy() throws IOException {
        emulator.close();
    }

    public static void main(String[] args) throws IOException {
        Demo demo = new Demo();
        // Call native methods here
        demo.destroy();
    }
}
```

---

## Loading SO Files

### Method 1: From File Path

```java
// Load from absolute path
DalvikModule dm = vm.loadLibrary(new File("/path/to/libnative.so"), true);

// Load from resources
DalvikModule dm = vm.loadLibrary("native", true);  // loads libnative.so from resources
```

### Method 2: From APK

```java
// Create VM with APK (auto-extracts SO)
vm = emulator.createDalvikVM(new File("app.apk"));
DalvikModule dm = vm.loadLibrary("native", true);
```

### Method 3: Multiple Libraries

```java
// Load dependencies first
vm.loadLibrary("c++_shared", true);
vm.loadLibrary("crypto", true);
vm.loadLibrary("ssl", true);

// Then load main library
DalvikModule dm = vm.loadLibrary("native", true);
dm.callJNI_OnLoad(emulator);
```

### Method 4: 64-bit Library

```java
emulator = AndroidEmulatorBuilder
        .for64Bit()
        .setProcessName("com.example.app")
        .build();

Memory memory = emulator.getMemory();
memory.setLibraryResolver(new AndroidResolver(23));

// Load arm64-v8a SO
DalvikModule dm = vm.loadLibrary(new File("lib/arm64-v8a/libnative.so"), true);
```

---

## Calling Native Functions

### Method 1: Call Static JNI Method

```java
// Java signature: public static native String sign(String input);
public String callSign(String input) {
    DvmObject<?> result = dvmClass.callStaticJniMethodObject(
            emulator,
            "sign(Ljava/lang/String;)Ljava/lang/String;",
            vm.addLocalObject(new StringObject(vm, input))
    );
    return result != null ? result.getValue().toString() : null;
}
```

### Method 2: Call Instance JNI Method

```java
// Java signature: public native byte[] encrypt(byte[] data, int key);
public byte[] callEncrypt(byte[] data, int key) {
    // Create instance
    DvmObject<?> instance = dvmClass.newObject(null);

    // Call method
    DvmObject<?> result = instance.callJniMethodObject(
            emulator,
            "encrypt([BI)[B",
            vm.addLocalObject(new ByteArray(vm, data)),
            key
    );

    if (result != null) {
        return (byte[]) result.getValue();
    }
    return null;
}
```

### Method 3: Call with Complex Parameters

```java
// Java: native String process(Context ctx, Map<String, Object> params);
public String callProcess() {
    // Mock Context
    DvmObject<?> context = vm.resolveClass("android/content/Context").newObject(null);

    // Create HashMap
    DvmClass hashMapClass = vm.resolveClass("java/util/HashMap");
    DvmObject<?> map = hashMapClass.newObject(null);

    // Put values (need to implement HashMap.put in AbstractJni)
    StringObject key = new StringObject(vm, "token");
    StringObject value = new StringObject(vm, "abc123");

    DvmObject<?> result = dvmClass.callStaticJniMethodObject(
            emulator,
            "process(Landroid/content/Context;Ljava/util/Map;)Ljava/lang/String;",
            vm.addLocalObject(context),
            vm.addLocalObject(map)
    );

    return result != null ? result.getValue().toString() : null;
}
```

### Method 4: Direct Function Call (Non-JNI)

```java
// Call exported function directly by symbol name
public int callNativeFunction(int arg1, int arg2) {
    // Find symbol
    Symbol symbol = module.findSymbolByName("native_add");
    if (symbol == null) {
        throw new RuntimeException("Symbol not found");
    }

    // Call function
    Number result = symbol.call(emulator, arg1, arg2)[0];
    return result.intValue();
}

// Call by address
public int callByAddress(long address, int arg1) {
    Number result = module.callFunction(emulator, address, arg1)[0];
    return result.intValue();
}
```

---

## Implementing JNI Callbacks (AbstractJni)

### Basic JNI Implementation

```java
public class Demo extends AbstractJni {

    @Override
    public DvmObject<?> callStaticObjectMethod(BaseVM vm, DvmClass dvmClass,
                                                String signature, VarArg varArg) {
        switch (signature) {
            case "android/os/Build->BRAND:Ljava/lang/String;":
                return new StringObject(vm, "Xiaomi");

            case "java/lang/System->getProperty(Ljava/lang/String;)Ljava/lang/String;":
                String key = varArg.getObjectArg(0).getValue().toString();
                if ("os.name".equals(key)) {
                    return new StringObject(vm, "Linux");
                }
                return null;

            case "java/util/UUID->randomUUID()Ljava/util/UUID;":
                return vm.resolveClass("java/util/UUID")
                        .newObject(java.util.UUID.randomUUID());
        }
        return super.callStaticObjectMethod(vm, dvmClass, signature, varArg);
    }

    @Override
    public DvmObject<?> callObjectMethod(BaseVM vm, DvmObject<?> dvmObject,
                                          String signature, VarArg varArg) {
        switch (signature) {
            case "android/content/Context->getPackageName()Ljava/lang/String;":
                return new StringObject(vm, "com.example.app");

            case "android/content/Context->getFilesDir()Ljava/io/File;":
                return vm.resolveClass("java/io/File")
                        .newObject(new File("/data/data/com.example.app/files"));

            case "java/lang/String->getBytes()[B":
                String str = dvmObject.getValue().toString();
                return new ByteArray(vm, str.getBytes());

            case "java/lang/String->getBytes(Ljava/lang/String;)[B":
                String s = dvmObject.getValue().toString();
                String charset = varArg.getObjectArg(0).getValue().toString();
                try {
                    return new ByteArray(vm, s.getBytes(charset));
                } catch (Exception e) {
                    return new ByteArray(vm, s.getBytes());
                }
        }
        return super.callObjectMethod(vm, dvmObject, signature, varArg);
    }

    @Override
    public int callStaticIntMethod(BaseVM vm, DvmClass dvmClass, String signature, VarArg varArg) {
        switch (signature) {
            case "android/os/Process->myPid()I":
                return 12345;

            case "android/os/Process->myUid()I":
                return 10086;
        }
        return super.callStaticIntMethod(vm, dvmClass, signature, varArg);
    }

    @Override
    public boolean callStaticBooleanMethod(BaseVM vm, DvmClass dvmClass,
                                            String signature, VarArg varArg) {
        switch (signature) {
            case "android/os/Debug->isDebuggerConnected()Z":
                return false;  // Anti-debug bypass
        }
        return super.callStaticBooleanMethod(vm, dvmClass, signature, varArg);
    }

    @Override
    public DvmObject<?> getStaticObjectField(BaseVM vm, DvmClass dvmClass, String signature) {
        switch (signature) {
            case "android/os/Build->MODEL:Ljava/lang/String;":
                return new StringObject(vm, "MI 10");

            case "android/os/Build->MANUFACTURER:Ljava/lang/String;":
                return new StringObject(vm, "Xiaomi");

            case "android/os/Build$VERSION->SDK_INT:I":
                return DvmInteger.valueOf(vm, 29);

            case "android/os/Build$VERSION->RELEASE:Ljava/lang/String;":
                return new StringObject(vm, "10");
        }
        return super.getStaticObjectField(vm, dvmClass, signature);
    }

    @Override
    public int getStaticIntField(BaseVM vm, DvmClass dvmClass, String signature) {
        switch (signature) {
            case "android/os/Build$VERSION->SDK_INT:I":
                return 29;
        }
        return super.getStaticIntField(vm, dvmClass, signature);
    }
}
```

### Common JNI Signatures Reference

```java
// Context methods
"android/content/Context->getPackageName()Ljava/lang/String;"
"android/content/Context->getApplicationContext()Landroid/content/Context;"
"android/content/Context->getContentResolver()Landroid/content/ContentResolver;"
"android/content/Context->getSharedPreferences(Ljava/lang/String;I)Landroid/content/SharedPreferences;"
"android/content/Context->getAssets()Landroid/content/res/AssetManager;"
"android/content/Context->getClassLoader()Ljava/lang/ClassLoader;"

// PackageManager
"android/content/Context->getPackageManager()Landroid/content/pm/PackageManager;"
"android/content/pm/PackageManager->getPackageInfo(Ljava/lang/String;I)Landroid/content/pm/PackageInfo;"

// Settings.Secure
"android/provider/Settings$Secure->getString(Landroid/content/ContentResolver;Ljava/lang/String;)Ljava/lang/String;"

// TelephonyManager
"android/telephony/TelephonyManager->getDeviceId()Ljava/lang/String;"
"android/telephony/TelephonyManager->getSimSerialNumber()Ljava/lang/String;"

// Build fields
"android/os/Build->BRAND:Ljava/lang/String;"
"android/os/Build->MODEL:Ljava/lang/String;"
"android/os/Build->DEVICE:Ljava/lang/String;"
"android/os/Build->PRODUCT:Ljava/lang/String;"
"android/os/Build->HARDWARE:Ljava/lang/String;"
"android/os/Build->FINGERPRINT:Ljava/lang/String;"
"android/os/Build$VERSION->SDK_INT:I"
"android/os/Build$VERSION->RELEASE:Ljava/lang/String;"
```

---

## Hooking Techniques

### Method 1: HookZz (Inline Hook)

```java
import com.github.unidbg.hook.hookzz.*;

public void hookWithHookZz() {
    HookZz hookZz = HookZz.getInstance(emulator);

    // Hook by symbol name
    hookZz.wrap(module.findSymbolByName("target_function"), new WrapCallback<HookZzArm32RegisterContext>() {
        @Override
        public void preCall(Emulator<?> emulator, HookZzArm32RegisterContext ctx, HookEntryInfo info) {
            // Before function call
            int arg0 = ctx.getR0Int();
            Pointer arg1 = ctx.getR1Pointer();
            System.out.println("target_function called with: " + arg0);

            // Read string from pointer
            String str = arg1.getString(0);
            System.out.println("String arg: " + str);

            // Modify argument
            ctx.setR0(999);
        }

        @Override
        public void postCall(Emulator<?> emulator, HookZzArm32RegisterContext ctx, HookEntryInfo info) {
            // After function returns
            int result = ctx.getR0Int();
            System.out.println("Return value: " + result);

            // Modify return value
            ctx.setR0(0);
        }
    });
}
```

### Method 2: xHook (PLT Hook)

```java
import com.github.unidbg.hook.xhook.IxHook;

public void hookWithXHook() {
    IxHook xHook = XHookImpl.getInstance(emulator);

    // Hook imported function
    xHook.register("libnative.so", "strlen", new ReplaceCallback() {
        @Override
        public HookStatus onCall(Emulator<?> emulator, long originFunction) {
            RegisterContext ctx = emulator.getContext();
            Pointer str = ctx.getPointerArg(0);
            System.out.println("strlen called: " + str.getString(0));

            // Call original
            return HookStatus.RET(emulator, originFunction);
        }
    });

    xHook.refresh();
}
```

### Method 3: Unicorn Hook

```java
import unicorn.CodeHook;

public void hookWithUnicorn() {
    // Hook specific address
    long targetAddress = module.base + 0x1234;

    emulator.getBackend().hook_add_new(new CodeHook() {
        @Override
        public void hook(Backend backend, long address, int size, Object user) {
            if (address == targetAddress) {
                RegisterContext ctx = emulator.getContext();
                System.out.println("Hit address: 0x" + Long.toHexString(address));

                // Read registers
                int r0 = ctx.getIntArg(0);
                System.out.println("R0 = " + r0);
            }
        }
    }, module.base, module.base + module.size, null);
}
```

### Method 4: Console Debugger

```java
public void attachDebugger() {
    // Attach debugger at address
    emulator.attach().addBreakPoint(module.base + 0x1234);

    // Or use console debugger
    Debugger debugger = emulator.attach();
    debugger.addBreakPoint(module, 0x1234, new BreakPointCallback() {
        @Override
        public boolean onHit(Emulator<?> emulator, long address) {
            RegisterContext ctx = emulator.getContext();
            System.out.println("Breakpoint hit!");

            // Dump registers
            ctx.getIntArg(0);  // R0
            ctx.getIntArg(1);  // R1

            return true;  // Continue execution
        }
    });
}
```

---

## Tracing & Debugging

### Instruction Tracing

```java
// Trace all instructions
emulator.traceCode();

// Trace specific range
emulator.traceCode(module.base, module.base + module.size);

// Trace with filter
emulator.traceCode(module.base, module.base + module.size)
        .setRedirect(new PrintStream("trace.log"));
```

### Memory Tracing

```java
// Trace memory read/write
emulator.traceRead(address, address + size);
emulator.traceWrite(address, address + size);

// Memory hook
emulator.getBackend().hook_add_new(new ReadHook() {
    @Override
    public void hook(Backend backend, long address, int size, Object user) {
        System.out.println("Memory read at: 0x" + Long.toHexString(address));
    }
}, begin, end, null);
```

### Function Call Tracing

```java
// Enable verbose JNI logging
vm.setVerbose(true);

// Custom trace
public class TracingJni extends AbstractJni {
    @Override
    public DvmObject<?> callObjectMethod(BaseVM vm, DvmObject<?> dvmObject,
                                          String signature, VarArg varArg) {
        System.out.println("[TRACE] callObjectMethod: " + signature);
        return super.callObjectMethod(vm, dvmObject, signature, varArg);
    }
}
```

### Dumping Memory

```java
// Dump memory region
byte[] data = emulator.getBackend().mem_read(address, size);
Files.write(Paths.get("dump.bin"), data);

// Dump module
byte[] moduleDump = emulator.getBackend().mem_read(module.base, module.size);
Files.write(Paths.get("module_dump.so"), moduleDump);

// Hex dump
Inspector.inspect(data, "Memory Dump");
```

---

## Common Patterns

### Pattern 1: Signature Function

```java
public class SignDemo extends AbstractJni {
    private final AndroidEmulator emulator;
    private final VM vm;
    private final Module module;
    private final DvmClass dvmClass;

    public SignDemo() {
        emulator = AndroidEmulatorBuilder.for32Bit()
                .setProcessName("com.example.app")
                .build();

        Memory memory = emulator.getMemory();
        memory.setLibraryResolver(new AndroidResolver(23));

        vm = emulator.createDalvikVM(new File("app.apk"));
        vm.setJni(this);
        vm.setVerbose(false);

        DalvikModule dm = vm.loadLibrary("sign", true);
        module = dm.getModule();
        dm.callJNI_OnLoad(emulator);

        dvmClass = vm.resolveClass("com/example/app/SignUtil");
    }

    public String sign(String data, long timestamp) {
        DvmObject<?> result = dvmClass.callStaticJniMethodObject(
                emulator,
                "sign(Ljava/lang/String;J)Ljava/lang/String;",
                vm.addLocalObject(new StringObject(vm, data)),
                timestamp
        );
        return result != null ? result.getValue().toString() : null;
    }

    public static void main(String[] args) {
        SignDemo demo = new SignDemo();
        String signature = demo.sign("hello", System.currentTimeMillis());
        System.out.println("Signature: " + signature);
    }
}
```

### Pattern 2: Encryption/Decryption

```java
public class CryptoDemo extends AbstractJni {

    public byte[] encrypt(byte[] plaintext, byte[] key) {
        DvmObject<?> result = dvmClass.callStaticJniMethodObject(
                emulator,
                "encrypt([B[B)[B",
                vm.addLocalObject(new ByteArray(vm, plaintext)),
                vm.addLocalObject(new ByteArray(vm, key))
        );
        return result != null ? (byte[]) result.getValue() : null;
    }

    public byte[] decrypt(byte[] ciphertext, byte[] key) {
        DvmObject<?> result = dvmClass.callStaticJniMethodObject(
                emulator,
                "decrypt([B[B)[B",
                vm.addLocalObject(new ByteArray(vm, ciphertext)),
                vm.addLocalObject(new ByteArray(vm, key))
        );
        return result != null ? (byte[]) result.getValue() : null;
    }
}
```

### Pattern 3: Device Info Spoofing

```java
@Override
public DvmObject<?> getStaticObjectField(BaseVM vm, DvmClass dvmClass, String signature) {
    switch (signature) {
        // Device spoofing
        case "android/os/Build->BRAND:Ljava/lang/String;":
            return new StringObject(vm, "samsung");
        case "android/os/Build->MODEL:Ljava/lang/String;":
            return new StringObject(vm, "SM-G9880");
        case "android/os/Build->DEVICE:Ljava/lang/String;":
            return new StringObject(vm, "x1q");
        case "android/os/Build->PRODUCT:Ljava/lang/String;":
            return new StringObject(vm, "x1qzh");
        case "android/os/Build->MANUFACTURER:Ljava/lang/String;":
            return new StringObject(vm, "samsung");
        case "android/os/Build->FINGERPRINT:Ljava/lang/String;":
            return new StringObject(vm, "samsung/x1qzh/x1q:11/RP1A.200720.012/G9880ZHS2DUL1:user/release-keys");
        case "android/os/Build->HARDWARE:Ljava/lang/String;":
            return new StringObject(vm, "qcom");
        case "android/os/Build->BOARD:Ljava/lang/String;":
            return new StringObject(vm, "kona");
    }
    return super.getStaticObjectField(vm, dvmClass, signature);
}

@Override
public DvmObject<?> callObjectMethod(BaseVM vm, DvmObject<?> dvmObject,
                                      String signature, VarArg varArg) {
    switch (signature) {
        // ANDROID_ID
        case "android/provider/Settings$Secure->getString(Landroid/content/ContentResolver;Ljava/lang/String;)Ljava/lang/String;":
            String name = varArg.getObjectArg(1).getValue().toString();
            if ("android_id".equals(name)) {
                return new StringObject(vm, "a1b2c3d4e5f67890");
            }
            break;
    }
    return super.callObjectMethod(vm, dvmObject, signature, varArg);
}
```

### Pattern 4: File System Access

```java
import com.github.unidbg.file.FileResult;
import com.github.unidbg.file.IOResolver;
import com.github.unidbg.linux.file.ByteArrayFileIO;
import com.github.unidbg.linux.file.SimpleFileIO;

public class Demo extends AbstractJni implements IOResolver<AndroidFileIO> {

    public Demo() {
        // ... setup code ...

        // Register file resolver
        emulator.getSyscallHandler().addIOResolver(this);
    }

    @Override
    public FileResult<AndroidFileIO> resolve(Emulator<AndroidFileIO> emulator,
                                              String pathname, int oflags) {
        // Mock /proc/self/maps
        if ("/proc/self/maps".equals(pathname)) {
            return FileResult.success(new ByteArrayFileIO(
                    oflags, pathname, "".getBytes()
            ));
        }

        // Mock /proc/self/status (anti-debug bypass)
        if ("/proc/self/status".equals(pathname)) {
            String content = "Name:\tapp_process\n" +
                    "TracerPid:\t0\n";  // 0 means not being traced
            return FileResult.success(new ByteArrayFileIO(
                    oflags, pathname, content.getBytes()
            ));
        }

        // Return actual file
        if (pathname.startsWith("/data/data/com.example.app/")) {
            File file = new File("./mock_files" + pathname);
            if (file.exists()) {
                return FileResult.success(new SimpleFileIO(oflags, file, pathname));
            }
        }

        // Let system handle it
        return null;
    }
}
```

---

## Troubleshooting

### Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `UnsupportedOperationException` | Unimplemented JNI method | Implement in AbstractJni subclass |
| `Backend does not support` | Wrong architecture | Match 32/64 bit with SO |
| `Symbol not found` | Function not exported | Check with `nm -D` or use address |
| `dlopen failed` | Missing dependency | Load dependencies first |
| `SIGBUS/SIGSEGV` | Memory access error | Check pointers and alignment |

### Debugging Tips

```java
// 1. Enable verbose logging
vm.setVerbose(true);

// 2. Print unhandled JNI calls
@Override
public DvmObject<?> callObjectMethod(BaseVM vm, DvmObject<?> dvmObject,
                                      String signature, VarArg varArg) {
    System.err.println("[UNHANDLED] callObjectMethod: " + signature);
    return super.callObjectMethod(vm, dvmObject, signature, varArg);
}

// 3. Trace execution
emulator.traceCode();

// 4. Attach debugger
emulator.attach().addBreakPoint(module, 0x1234);

// 5. Memory inspection
Inspector.inspect(emulator.getBackend().mem_read(addr, 0x100), "Memory");
```

### Finding Target Function

```bash
# List exports
nm -D libnative.so | grep -i sign

# Find JNI methods
nm -D libnative.so | grep Java_

# Disassemble
objdump -d libnative.so | less

# Using radare2
r2 -A libnative.so
> afl  # list functions
> pdf @sym.Java_com_example_sign  # disassemble
```

---

## Example Usage

```
/unidbg

Target: libnative.so from com.example.app
Function: public static native String sign(String input, long timestamp)
Class: com.example.app.SignUtil
```

The assistant will:

1. Generate a complete Maven/Gradle project structure
2. Create the main emulator class extending AbstractJni
3. Implement common JNI callbacks based on the target app
4. Add the function call code with proper signature
5. Include debugging and tracing code
6. Provide troubleshooting guidance

## Tips

1. **Always call `JNI_OnLoad`** - Most libraries initialize here
2. **Match architecture** - Use `for32Bit()` for armeabi-v7a, `for64Bit()` for arm64-v8a
3. **Load dependencies in order** - libc++, crypto libraries before main SO
4. **Handle all JNI callbacks** - Trace unimplemented ones and add as needed
5. **Use APK when possible** - Provides proper class loading context
6. **Mock file system access** - Many apps read `/proc/`, device files
7. **Spoof device info** - Build.*, ANDROID_ID for fingerprinting
8. **Disable anti-debug** - TracerPid=0, isDebuggerConnected()=false
