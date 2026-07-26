#!/bin/bash

# APK SO Analyzer - Extract and analyze SO files from APK using radare2
# Usage: ./analyze_apk_so.sh <apk_file> <so_name> [output_dir] [--filter keyword] [--filter-type type]

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Default values
FILTER=""
FILTER_TYPE="all"
OUTPUT_DIR="./apk_so_analysis"
SO_NAMES=()
APK_FILE=""

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --filter)
            FILTER="$2"
            shift 2
            ;;
        --filter-type)
            FILTER_TYPE="$2"
            shift 2
            ;;
        --output|-o)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        --help|-h)
            echo "APK SO Analyzer - Extract and analyze SO files from APK"
            echo ""
            echo "Usage: $0 <apk_file> <so_name> [so_name2...] [options]"
            echo ""
            echo "Options:"
            echo "  --filter <keyword>     Filter functions by keyword (case-insensitive)"
            echo "  --filter-type <type>   Filter type: jni, class, method, all (default: all)"
            echo "  --output, -o <dir>     Output directory (default: ./apk_so_analysis)"
            echo "  --help, -h             Show this help"
            echo ""
            echo "Filter Types:"
            echo "  jni     - JNI functions only (Java_*, JNI_OnLoad)"
            echo "  class   - Match class/namespace names"
            echo "  method  - Match method names"
            echo "  all     - Match anywhere in function name"
            echo ""
            echo "Examples:"
            echo "  $0 app.apk libnative.so"
            echo "  $0 app.apk libfp.so libfph.so --filter fingerprint"
            echo "  $0 app.apk libnative.so --filter-type jni"
            echo "  $0 app.apk libcrypto.so --filter encrypt --filter-type method"
            exit 0
            ;;
        -*)
            echo -e "${RED}Unknown option: $1${NC}"
            exit 1
            ;;
        *)
            if [ -z "$APK_FILE" ]; then
                APK_FILE="$1"
            else
                SO_NAMES+=("$1")
            fi
            shift
            ;;
    esac
done

# Validate arguments
if [ -z "$APK_FILE" ] || [ ${#SO_NAMES[@]} -eq 0 ]; then
    echo -e "${RED}Usage: $0 <apk_file> <so_name> [so_name2...] [options]${NC}"
    echo "Example: $0 app.apk libnative.so --filter encrypt"
    echo "Run '$0 --help' for more options"
    exit 1
fi

if [ ! -f "$APK_FILE" ]; then
    echo -e "${RED}Error: APK file not found: $APK_FILE${NC}"
    exit 1
fi

# Check radare2
if ! command -v r2 &> /dev/null; then
    echo -e "${RED}Error: radare2 (r2) not found. Please install it first.${NC}"
    echo "  brew install radare2  # macOS"
    echo "  apt install radare2   # Linux"
    exit 1
fi

# Create output directory
mkdir -p "$OUTPUT_DIR"
WORK_DIR=$(mktemp -d)

echo -e "${BLUE}╔══════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║       APK SO Analyzer v2.0               ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "${GREEN}APK File:${NC} $APK_FILE"
echo -e "${GREEN}Target SO:${NC} ${SO_NAMES[*]}"
echo -e "${GREEN}Output:${NC} $OUTPUT_DIR"
if [ -n "$FILTER" ]; then
    echo -e "${CYAN}Filter:${NC} '$FILTER' (type: $FILTER_TYPE)"
fi
echo ""

# Step 1: Extract APK
echo -e "${YELLOW}[1/5] Extracting APK...${NC}"
unzip -q "$APK_FILE" -d "$WORK_DIR"

# Function to apply filter based on type
apply_filter() {
    local input="$1"
    local keyword="$2"
    local filter_type="$3"

    if [ -z "$keyword" ]; then
        echo "$input"
        return
    fi

    case "$filter_type" in
        jni)
            echo "$input" | grep -iE "(Java_.*${keyword}|JNI_OnLoad|JNI_OnUnload)" 2>/dev/null || true
            ;;
        class)
            # Match C++ class names (before ::)
            echo "$input" | grep -iE "[^:]*${keyword}[^:]*::" 2>/dev/null || true
            ;;
        method)
            # Match method names (after ::)
            echo "$input" | grep -iE "::.*${keyword}" 2>/dev/null || true
            ;;
        all|*)
            echo "$input" | grep -i "$keyword" 2>/dev/null || true
            ;;
    esac
}

# Function to analyze a single SO file
analyze_so() {
    local SO_NAME="$1"
    local SO_NUM="$2"
    local SO_TOTAL="$3"

    echo ""
    echo -e "${BLUE}━━━ Analyzing: $SO_NAME ($SO_NUM/$SO_TOTAL) ━━━${NC}"

    # Find SO file
    SO_FILES=$(find "$WORK_DIR/lib" -name "$SO_NAME" 2>/dev/null || true)

    if [ -z "$SO_FILES" ]; then
        echo -e "${RED}Warning: SO file '$SO_NAME' not found in APK${NC}"
        echo "Available SO files:"
        find "$WORK_DIR/lib" -name "*.so" 2>/dev/null | sed 's|.*/lib/||' | head -20
        return 1
    fi

    # Use first found (prefer arm64-v8a)
    SO_PATH=""
    for arch in "arm64-v8a" "armeabi-v7a" "x86_64" "x86"; do
        candidate="$WORK_DIR/lib/$arch/$SO_NAME"
        if [ -f "$candidate" ]; then
            SO_PATH="$candidate"
            ARCH="$arch"
            break
        fi
    done

    if [ -z "$SO_PATH" ]; then
        SO_PATH=$(echo "$SO_FILES" | head -1)
        ARCH=$(echo "$SO_PATH" | sed -n 's|.*/lib/\([^/]*\)/.*|\1|p')
    fi

    echo -e "${GREEN}Found:${NC} $SO_PATH (arch: $ARCH)"

    # Copy SO to output
    cp "$SO_PATH" "$OUTPUT_DIR/"

    # Get file info
    FILE_SIZE=$(ls -lh "$SO_PATH" | awk '{print $5}')
    SHA256=$(shasum -a 256 "$SO_PATH" | awk '{print $1}')

    REPORT_FILE="$OUTPUT_DIR/${SO_NAME%.so}_report.md"
    JSON_FILE="$OUTPUT_DIR/${SO_NAME%.so}_exports.json"

    # Radare2 Analysis
    echo -e "  ${YELLOW}Getting binary info...${NC}"
    BINARY_INFO=$(r2 -q -c "iI" "$SO_PATH" 2>/dev/null)

    echo -e "  ${YELLOW}Extracting exports...${NC}"
    EXPORTS_RAW=$(r2 -q -c "iE" "$SO_PATH" 2>/dev/null)

    # Apply filter to exports
    if [ -n "$FILTER" ]; then
        EXPORTS=$(apply_filter "$EXPORTS_RAW" "$FILTER" "$FILTER_TYPE")
        EXPORT_COUNT=$(echo "$EXPORTS" | grep -c "FUNC\|OBJ" || echo "0")
        TOTAL_EXPORTS=$(echo "$EXPORTS_RAW" | grep -c "FUNC\|OBJ" || echo "0")
        echo -e "  ${CYAN}Filtered: $EXPORT_COUNT / $TOTAL_EXPORTS exports match '$FILTER'${NC}"
    else
        EXPORTS="$EXPORTS_RAW"
        EXPORT_COUNT=$(echo "$EXPORTS" | grep -c "FUNC\|OBJ" || echo "0")
    fi

    echo -e "  ${YELLOW}Extracting imports...${NC}"
    IMPORTS=$(r2 -q -c "ii" "$SO_PATH" 2>/dev/null)
    IMPORT_COUNT=$(echo "$IMPORTS" | grep -c "FUNC\|OBJ" || echo "0")

    echo -e "  ${YELLOW}Analyzing functions...${NC}"
    FUNCTIONS_RAW=$(r2 -q -c "aaa; afl" "$SO_PATH" 2>/dev/null)
    if [ -n "$FILTER" ]; then
        FUNCTIONS=$(apply_filter "$FUNCTIONS_RAW" "$FILTER" "$FILTER_TYPE")
    else
        FUNCTIONS="$FUNCTIONS_RAW"
    fi
    FUNC_COUNT=$(echo "$FUNCTIONS" | wc -l | tr -d ' ')

    # Cross-reference analysis for filtered functions
    echo -e "  ${YELLOW}Analyzing cross-references...${NC}"
    XREF_RESULTS=""

    if [ -n "$FILTER" ]; then
        # Only analyze xrefs for filtered functions
        FILTERED_ADDRS=$(echo "$EXPORTS" | grep "FUNC" | awk '{print $2}' | head -20)
    else
        FILTERED_ADDRS=$(echo "$EXPORTS" | grep "FUNC" | awk '{print $2}' | head -30)
    fi

    for addr in $FILTERED_ADDRS; do
        if [ -n "$addr" ] && [[ "$addr" =~ ^0x ]]; then
            func_name=$(echo "$EXPORTS" | grep "$addr" | awk '{print $NF}' | head -1)
            xrefs=$(r2 -q -c "aaa; axt @ $addr" "$SO_PATH" 2>/dev/null | head -10)
            if [ -n "$xrefs" ]; then
                XREF_RESULTS="${XREF_RESULTS}\n### $func_name ($addr)\n\`\`\`\n$xrefs\n\`\`\`\n"
            fi
        fi
    done

    # Identify JNI functions
    JNI_FUNCS=$(echo "$EXPORTS_RAW" | grep -E "Java_|JNI_OnLoad|JNI_OnUnload" || echo "None detected")

    # Decompile filtered functions if filter is set
    DECOMPILED=""
    if [ -n "$FILTER" ]; then
        echo -e "  ${YELLOW}Decompiling filtered functions...${NC}"
        FUNC_ADDRS=$(echo "$EXPORTS" | grep "FUNC" | awk '{print $2}' | head -5)
        for addr in $FUNC_ADDRS; do
            if [ -n "$addr" ] && [[ "$addr" =~ ^0x ]]; then
                func_name=$(echo "$EXPORTS" | grep "$addr" | awk '{print $NF}' | head -1)
                decomp=$(r2 -q -c "aaa; pdc @ $addr" "$SO_PATH" 2>/dev/null | head -100)
                if [ -n "$decomp" ]; then
                    DECOMPILED="${DECOMPILED}\n### $func_name ($addr)\n\`\`\`c\n$decomp\n\`\`\`\n"
                fi
            fi
        done
    fi

    # Generate report
    echo -e "  ${YELLOW}Generating report...${NC}"

    cat > "$REPORT_FILE" << EOF
# SO Analysis Report: $SO_NAME

**Generated:** $(date "+%Y-%m-%d %H:%M:%S")
**APK:** $(basename "$APK_FILE")
EOF

    if [ -n "$FILTER" ]; then
        cat >> "$REPORT_FILE" << EOF
**Filter:** \`$FILTER\` (type: $FILTER_TYPE)
EOF
    fi

    cat >> "$REPORT_FILE" << EOF

## Basic Information

| Property | Value |
|----------|-------|
| SO File | $SO_NAME |
| Architecture | $ARCH |
| File Size | $FILE_SIZE |
| SHA256 | \`$SHA256\` |
| Export Count | $EXPORT_COUNT |
| Import Count | $IMPORT_COUNT |
| Function Count | $FUNC_COUNT |

## Binary Info

\`\`\`
$BINARY_INFO
\`\`\`

EOF

    if [ -n "$FILTER" ]; then
        cat >> "$REPORT_FILE" << EOF
## Filtered Exports ($EXPORT_COUNT matching "$FILTER")

\`\`\`
$EXPORTS
\`\`\`

EOF
    else
        cat >> "$REPORT_FILE" << EOF
## Exports ($EXPORT_COUNT)

\`\`\`
$EXPORTS
\`\`\`

EOF
    fi

    cat >> "$REPORT_FILE" << EOF
## Imports ($IMPORT_COUNT)

\`\`\`
$IMPORTS
\`\`\`

## Functions (Top 50)

\`\`\`
$(echo "$FUNCTIONS" | head -50)
\`\`\`

## Cross References

$(echo -e "$XREF_RESULTS")

## JNI Functions

\`\`\`
$JNI_FUNCS
\`\`\`

EOF

    if [ -n "$DECOMPILED" ]; then
        cat >> "$REPORT_FILE" << EOF
## Decompiled Code (Filtered Functions)

$(echo -e "$DECOMPILED")

EOF
    fi

    cat >> "$REPORT_FILE" << EOF
## Available Architectures

\`\`\`
$(find "$WORK_DIR/lib" -name "$SO_NAME" 2>/dev/null | sed 's|.*/lib/||')
\`\`\`

---

## Next Steps

1. **Decompile specific function:**
   \`\`\`bash
   r2 -q -c "aaa; pdc @ sym.function_name" "$OUTPUT_DIR/$SO_NAME"
   \`\`\`

2. **Find xrefs to specific function:**
   \`\`\`bash
   r2 -q -c "aaa; axt @ sym.function_name" "$OUTPUT_DIR/$SO_NAME"
   \`\`\`

3. **Search strings:**
   \`\`\`bash
   r2 -q -c "izz~keyword" "$OUTPUT_DIR/$SO_NAME"
   \`\`\`
EOF

    # Generate JSON for programmatic use
    r2 -q -c "iEj" "$SO_PATH" > "$JSON_FILE" 2>/dev/null || echo "[]" > "$JSON_FILE"

    echo -e "  ${GREEN}Report saved:${NC} $REPORT_FILE"

    # Print summary
    echo -e "  ${CYAN}Summary:${NC}"
    echo -e "    - Exports: $EXPORT_COUNT"
    echo -e "    - Imports: $IMPORT_COUNT"
    echo -e "    - Functions: $FUNC_COUNT"
}

# Analyze each SO file
SO_TOTAL=${#SO_NAMES[@]}
SO_NUM=0
for SO_NAME in "${SO_NAMES[@]}"; do
    ((SO_NUM++))
    analyze_so "$SO_NAME" "$SO_NUM" "$SO_TOTAL" || true
done

# Cleanup
rm -rf "$WORK_DIR"

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║         Analysis Complete!               ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "Output directory: ${BLUE}$OUTPUT_DIR${NC}"
ls -la "$OUTPUT_DIR"/*.md 2>/dev/null | awk '{print "  - " $NF}'
echo ""
