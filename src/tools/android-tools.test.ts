import { describe, expect, test } from "bun:test";
import { parseManifestTree } from "./android-tools";

// aapt2 xmltree style: E:/A: lines, no end tags. The second intent-filter of
// MainActivity is followed directly by the service element, and the service has
// a single name attribute — this is where the parser used to drop filters.
const XMLTREE = [
  "N: android=http://schemas.android.com/apk/res/android",
  "  E: manifest (line=2)",
  '    A: package="com.example.app"',
  '    A: android:versionCode(0x0101021b)="7"',
  '    A: android:versionName(0x0101021c)="1.2.3"',
  "  E: uses-permission (line=5)",
  '    A: android:name(0x01010003)="android.permission.INTERNET"',
  "  E: application (line=8)",
  "    E: activity (line=10)",
  '      A: android:name(0x01010003)="com.example.app.MainActivity"',
  '      A: android:exported(0x01010010)="true"',
  "      E: intent-filter (line=13)",
  "        E: action (line=14)",
  '          A: android:name(0x01010003)="android.intent.action.MAIN"',
  "        E: category (line=16)",
  '          A: android:name(0x01010003)="android.intent.category.LAUNCHER"',
  "      E: intent-filter (line=19)",
  "        E: action (line=20)",
  '          A: android:name(0x01010003)="android.intent.action.VIEW"',
  "    E: service (line=23)",
  '      A: android:name(0x01010003)="com.example.app.CrunchService"',
  "",
].join("\n");

describe("parseManifestTree (xmltree)", () => {
  test("keeps every intent-filter of a component when the next element is another component", () => {
    const info = parseManifestTree(XMLTREE);
    expect(info.packageName).toBe("com.example.app");
    expect(info.versionCode).toBe("7");
    expect(info.versionName).toBe("1.2.3");
    expect(info.permissions).toContain("android.permission.INTERNET");
    expect(info.activities).toEqual([
      {
        name: "com.example.app.MainActivity",
        exported: "true",
        intentFilters: [
          "android.intent.action.MAIN, android.intent.category.LAUNCHER",
          "android.intent.action.VIEW",
        ],
      },
    ]);
    // No filter may leak onto the component that follows.
    expect(info.services).toEqual([{ name: "com.example.app.CrunchService", exported: "unset", intentFilters: [] }]);
  });
});

describe("parseManifestTree (badging)", () => {
  test("parses badging output that carries versionCodeRel between versionCode and versionName", () => {
    const raw = [
      "package: name='com.example.badging' versionCode='42' versionCodeRel='42' versionName='2.0' compileSdkVersion='33'",
      "sdkVersion:'21'",
      "targetSdkVersion:'33'",
      "uses-permission: name='android.permission.CAMERA'",
      "",
    ].join("\n");
    const info = parseManifestTree(raw);
    expect(info.packageName).toBe("com.example.badging");
    expect(info.versionCode).toBe("42");
    expect(info.versionName).toBe("2.0");
    expect(info.minSdk).toBe("21");
    expect(info.targetSdk).toBe("33");
    expect(info.permissions).toContain("android.permission.CAMERA");
  });

  test("still parses the classic badging layout without versionCodeRel", () => {
    const info = parseManifestTree("package: name='com.example.old' versionCode='3' versionName='1.0'\n");
    expect(info.packageName).toBe("com.example.old");
    expect(info.versionCode).toBe("3");
    expect(info.versionName).toBe("1.0");
  });
});
