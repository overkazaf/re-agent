#!/bin/bash
#
# analyze_so.sh - Radare2 SO/ELF Analysis Script
# Usage: ./analyze_so.sh <path_to_so_file> [output_dir]
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Check arguments
if [ $# -lt 1 ]; then
    echo -e "${RED}Usage: $0 <so_file> [output_dir]${NC}"
    exit 1
fi

SO_FILE="$1"
OUTPUT_DIR="${2:-.}"

# Validate file exists
if [ ! -f "$SO_FILE" ]; then
    echo -e "${RED}Error: File not found: $SO_FILE${NC}"
    exit 1
fi

# Check radare2 installation
if ! command -v r2 &> /dev/null; then
    echo -e "${RED}Error: radare2 (r2) is not installed${NC}"
    echo "Install with: brew install radare2 (macOS) or apt install radare2 (Linux)"
    exit 1
fi

# Get filename for output
BASENAME=$(basename "$SO_FILE")
REPORT_FILE="${OUTPUT_DIR}/${BASENAME}_analysis.txt"
JSON_FILE="${OUTPUT_DIR}/${BASENAME}_analysis.json"

echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}  Radare2 SO/ELF Analysis Report${NC}"
echo -e "${CYAN}========================================${NC}"
echo -e "${YELLOW}Target: ${SO_FILE}${NC}"
echo -e "${YELLOW}Output: ${REPORT_FILE}${NC}"
echo ""

# Create output directory if needed
mkdir -p "$OUTPUT_DIR"

# Start report
{
    echo "========================================"
    echo "  Radare2 SO/ELF Analysis Report"
    echo "========================================"
    echo "Target File: $SO_FILE"
    echo "Analysis Date: $(date)"
    echo "File Size: $(ls -lh "$SO_FILE" | awk '{print $5}')"
    echo "MD5: $(md5sum "$SO_FILE" 2>/dev/null || md5 -q "$SO_FILE" 2>/dev/null || echo 'N/A')"
    echo "SHA256: $(sha256sum "$SO_FILE" 2>/dev/null || shasum -a 256 "$SO_FILE" 2>/dev/null | awk '{print $1}' || echo 'N/A')"
    echo ""
} > "$REPORT_FILE"

# Function to run r2 command and append to report
r2_cmd() {
    local title="$1"
    local cmd="$2"
    echo -e "${GREEN}[*] $title${NC}"
    {
        echo "----------------------------------------"
        echo ">>> $title"
        echo "----------------------------------------"
        r2 -q -e scr.color=0 -c "$cmd" "$SO_FILE" 2>/dev/null || echo "(Command failed or no output)"
        echo ""
    } >> "$REPORT_FILE"
}

# ============================================
# Section 1: File Information
# ============================================
echo -e "${BLUE}[Section 1] File Information${NC}"

r2_cmd "Binary Info (iI)" "iI"
r2_cmd "File Header (ih)" "ih"
r2_cmd "Entry Points (ie)" "ie"
r2_cmd "Main Address (iM)" "iM"

# ============================================
# Section 2: Sections & Segments
# ============================================
echo -e "${BLUE}[Section 2] Sections & Segments${NC}"

r2_cmd "Sections (iS)" "iS"
r2_cmd "Segments (iSS)" "iSS"
r2_cmd "Section Entropy (iS entropy)" "iS entropy"

# ============================================
# Section 3: Imports
# ============================================
echo -e "${BLUE}[Section 3] Imports${NC}"

r2_cmd "Imports (ii)" "ii"
r2_cmd "Import Count" "ii~?"

# ============================================
# Section 4: Exports
# ============================================
echo -e "${BLUE}[Section 4] Exports${NC}"

r2_cmd "Exports (iE)" "iE"
r2_cmd "Export Count" "iE~?"

# ============================================
# Section 5: Symbols
# ============================================
echo -e "${BLUE}[Section 5] Symbols${NC}"

r2_cmd "Symbols (is)" "is"
r2_cmd "Symbol Count" "is~?"

# ============================================
# Section 6: Relocations
# ============================================
echo -e "${BLUE}[Section 6] Relocations${NC}"

r2_cmd "Relocations (ir)" "ir"

# ============================================
# Section 7: Libraries & Dependencies
# ============================================
echo -e "${BLUE}[Section 7] Libraries & Dependencies${NC}"

r2_cmd "Linked Libraries (il)" "il"

# ============================================
# Section 8: Strings Analysis
# ============================================
echo -e "${BLUE}[Section 8] Strings Analysis${NC}"

r2_cmd "Strings in Data Section (izz)" "izz~?"
r2_cmd "Strings Sample (first 50)" "izz~:0..50"

# Look for interesting strings
{
    echo "----------------------------------------"
    echo ">>> Interesting Strings (URLs, IPs, Paths)"
    echo "----------------------------------------"
    r2 -q -e scr.color=0 -c "izz" "$SO_FILE" 2>/dev/null | grep -iE "(http|https|ftp|file://|/data/|/system/|\.so|\.dex|\.apk|password|secret|key|token|api)" | head -100 || echo "(No interesting strings found)"
    echo ""
} >> "$REPORT_FILE"

# ============================================
# Section 9: Function Analysis
# ============================================
echo -e "${BLUE}[Section 9] Function Analysis${NC}"

r2_cmd "Functions (aaa + afl)" "aaa; afl"
r2_cmd "Function Count" "aaa; afl~?"

# ============================================
# Section 10: Cross References
# ============================================
echo -e "${BLUE}[Section 10] Cross References${NC}"

r2_cmd "Cross References to main (if exists)" "aaa; axt @ sym.main"

# ============================================
# Section 11: Security Features
# ============================================
echo -e "${BLUE}[Section 11] Security Features${NC}"

r2_cmd "Security Info (iI~canary|nx|pic|relro)" "iI~canary,nx,pic,relro,crypto,stripped"

# ============================================
# Section 12: Class/Method Info (for Android .so)
# ============================================
echo -e "${BLUE}[Section 12] JNI Functions (Android)${NC}"

{
    echo "----------------------------------------"
    echo ">>> JNI Native Functions"
    echo "----------------------------------------"
    r2 -q -e scr.color=0 -c "is" "$SO_FILE" 2>/dev/null | grep -iE "(Java_|JNI_OnLoad|JNI_OnUnload)" || echo "(No JNI functions found)"
    echo ""
} >> "$REPORT_FILE"

# ============================================
# Generate JSON Summary
# ============================================
echo -e "${BLUE}[*] Generating JSON Summary${NC}"

r2 -q -e scr.color=0 -c "
iIj;
echo ==SECTIONS==
iSj;
echo ==IMPORTS==
iij;
echo ==EXPORTS==
iEj;
echo ==SYMBOLS==
isj;
echo ==LIBS==
ilj;
echo ==STRINGS_COUNT==
izz~?;
" "$SO_FILE" 2>/dev/null > "$JSON_FILE" || true

# ============================================
# Summary
# ============================================
echo -e "${BLUE}[Section 13] Analysis Summary${NC}"

{
    echo "========================================"
    echo "  ANALYSIS SUMMARY"
    echo "========================================"
    echo ""

    # Extract key metrics
    IMPORT_COUNT=$(r2 -q -e scr.color=0 -c "ii~?" "$SO_FILE" 2>/dev/null || echo "0")
    EXPORT_COUNT=$(r2 -q -e scr.color=0 -c "iE~?" "$SO_FILE" 2>/dev/null || echo "0")
    SYMBOL_COUNT=$(r2 -q -e scr.color=0 -c "is~?" "$SO_FILE" 2>/dev/null || echo "0")
    STRING_COUNT=$(r2 -q -e scr.color=0 -c "izz~?" "$SO_FILE" 2>/dev/null || echo "0")
    FUNC_COUNT=$(r2 -q -e scr.color=0 -c "aaa;afl~?" "$SO_FILE" 2>/dev/null || echo "0")

    echo "Imports:    $IMPORT_COUNT"
    echo "Exports:    $EXPORT_COUNT"
    echo "Symbols:    $SYMBOL_COUNT"
    echo "Strings:    $STRING_COUNT"
    echo "Functions:  $FUNC_COUNT"
    echo ""

    # Security summary
    echo "Security Features:"
    r2 -q -e scr.color=0 -c "iI" "$SO_FILE" 2>/dev/null | grep -iE "(canary|nx|pic|relro|stripped)" || echo "  (Unable to determine)"
    echo ""

    # JNI check
    JNI_COUNT=$(r2 -q -e scr.color=0 -c "is" "$SO_FILE" 2>/dev/null | grep -ciE "(Java_|JNI_OnLoad)" || echo "0")
    if [ "$JNI_COUNT" -gt 0 ]; then
        echo "JNI Native Methods: $JNI_COUNT (Android native library)"
    else
        echo "JNI Native Methods: None detected"
    fi
    echo ""

    echo "========================================"
    echo "  END OF REPORT"
    echo "========================================"
} >> "$REPORT_FILE"

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  Analysis Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo -e "Report: ${CYAN}$REPORT_FILE${NC}"
echo -e "JSON:   ${CYAN}$JSON_FILE${NC}"
echo ""

# Print quick summary
echo -e "${YELLOW}Quick Summary:${NC}"
tail -25 "$REPORT_FILE"
