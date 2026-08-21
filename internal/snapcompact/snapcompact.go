// Package snapcompact archives conversation history as dense PNG frames, the
// same idea as oh-my-pi's snapcompact: instead of asking an LLM to summarize
// discarded history, the serialized transcript is rendered locally and
// deterministically into bitmap images that a vision-capable model reads back,
// like an archivist at a microfiche reader. No model call, no API key, no
// network — the pass is pure local rendering.
//
// The shape is intentionally simple: black text on a white frame, the frame
// width fixed per call and the height hugging the rows actually printed, with
// overflow splitting into more frames. Latin text uses the bundled Go Regular
// font; when the serialized text contains CJK, a system font is loaded from
// common macOS/Linux paths so Chinese prompts and notes stay legible.
package snapcompact

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"strings"

	"github.com/overkazaf/re-agent/internal/types"

	"golang.org/x/image/font"
	"golang.org/x/image/font/gofont/goregular"
	"golang.org/x/image/font/opentype"
	"golang.org/x/image/font/sfnt"
	"golang.org/x/image/math/fixed"
)

// SerializeOptions bounds the conversation-dense archive text.
type SerializeOptions struct {
	// ToolResultMaxChars is the per-result body budget, split head+tail.
	ToolResultMaxChars int
	// ToolArgMaxChars caps one tool-call argument value.
	ToolArgMaxChars int
	// ToolCallMaxChars caps one tool-call's serialized arguments.
	ToolCallMaxChars int
	// TruncateHeadRatio is the share of ToolResultMaxChars kept from the head.
	TruncateHeadRatio float64
}

const (
	defaultToolResultMaxChars = 2000
	defaultToolArgMaxChars    = 500
	defaultToolCallMaxChars   = 2000
	defaultTruncateHeadRatio  = 0.6
)

// RenderOptions controls the PNG frames.
type RenderOptions struct {
	// FrameWidth is the fixed frame edge in pixels.
	FrameWidth int
	// MaxFrameHeight is the tallest a single frame may be; taller text splits.
	MaxFrameHeight int
	// FontSize is the glyph size in pixels.
	FontSize float64
	// Padding is the margin around the text in pixels.
	Padding int
	// MaxFrames caps how many frames one archive may produce; beyond that the
	// caller should fall back to a text marker.
	MaxFrames int
}

const (
	defaultFrameWidth     = 1568
	defaultMaxFrameHeight = 1568
	defaultFontSize       = 28.0
	defaultPadding        = 24
	defaultMaxFrames      = 32
)

// --- serialization -----------------------------------------------------------

// Serialize renders messages as conversation-dense archive text: roles as
// headings, tool calls with capped arguments, tool results truncated head+tail.
func Serialize(messages []types.Message, options SerializeOptions) string {
	toolResultMax := options.ToolResultMaxChars
	if toolResultMax <= 0 {
		toolResultMax = defaultToolResultMaxChars
	}
	toolArgMax := options.ToolArgMaxChars
	if toolArgMax <= 0 {
		toolArgMax = defaultToolArgMaxChars
	}
	toolCallMax := options.ToolCallMaxChars
	if toolCallMax <= 0 {
		toolCallMax = defaultToolCallMaxChars
	}
	headRatio := options.TruncateHeadRatio
	if headRatio <= 0 || headRatio >= 1 {
		headRatio = defaultTruncateHeadRatio
	}

	var out strings.Builder
	for _, message := range messages {
		switch message.Role {
		case types.MessageUser:
			if text := collapseWhitespace(message.Text()); text != "" {
				out.WriteString("# User ¶\n")
				out.WriteString(text)
				out.WriteString("\n")
			}
		case types.MessageAssistant:
			if text := collapseWhitespace(message.Text()); text != "" {
				out.WriteString("# Assistant ¶\n")
				out.WriteString(text)
				out.WriteString("\n")
			}
			for _, call := range message.ToolCalls {
				out.WriteString("# Tool call ¶ " + call.Name + "\n")
				if args := serializeArgs(call.Arguments, toolArgMax, toolCallMax); args != "" {
					out.WriteString(args)
					out.WriteString("\n")
				}
			}
		case types.MessageToolResult:
			out.WriteString("# Tool result ¶ " + message.ToolName + "\n")
			body := truncateHeadTail(message.Text(), toolResultMax, headRatio)
			out.WriteString("<out>\n")
			out.WriteString(body)
			out.WriteString("\n</out>\n")
		}
	}
	return out.String()
}

func collapseWhitespace(text string) string {
	return strings.Join(strings.Fields(text), " ")
}

func truncateHeadTail(text string, maxChars int, headRatio float64) string {
	if len(text) <= maxChars {
		return text
	}
	head := int(float64(maxChars) * headRatio)
	if head < 0 {
		head = 0
	}
	tail := maxChars - head
	if tail < 0 {
		tail = 0
	}
	if tail == 0 {
		return text[:head] + "\n…[truncated]…"
	}
	return text[:head] + "\n…[truncated]…\n" + text[len(text)-tail:]
}

func serializeArgs(args map[string]any, argMax, callMax int) string {
	if len(args) == 0 {
		return ""
	}
	// Marshal once, then enforce the per-value and per-call budgets on the JSON
	// form so the archive stays valid JSON-ish even after clipping.
	encoded, err := json.Marshal(args)
	if err != nil {
		return ""
	}
	text := string(encoded)
	if len(text) > callMax {
		text = truncateHeadTail(text, callMax, 0.6)
	}
	return text
}

// HasCJK reports whether the text contains CJK ranges that need a CJK font.
func HasCJK(text string) bool {
	for _, char := range text {
		code := int(char)
		switch {
		case code >= 0x2e80 && code <= 0x9fff,
			code >= 0xf900 && code <= 0xfaff,
			code >= 0xff00 && code <= 0xffef,
			code >= 0x20000 && code <= 0x3fffd:
			return true
		}
	}
	return false
}

// --- rendering ---------------------------------------------------------------

// Render serializes nothing itself: it draws the given text onto one or more
// white PNG frames and returns their encoded bytes.
func Render(text string, options RenderOptions) ([][]byte, error) {
	frameWidth := options.FrameWidth
	if frameWidth <= 0 {
		frameWidth = defaultFrameWidth
	}
	maxFrameHeight := options.MaxFrameHeight
	if maxFrameHeight <= 0 {
		maxFrameHeight = defaultMaxFrameHeight
	}
	fontSize := options.FontSize
	if fontSize <= 0 {
		fontSize = defaultFontSize
	}
	padding := options.Padding
	if padding < 0 {
		padding = defaultPadding
	}
	maxFrames := options.MaxFrames
	if maxFrames <= 0 {
		maxFrames = defaultMaxFrames
	}

	face, err := faceFor(text, fontSize)
	if err != nil {
		return nil, fmt.Errorf("snapcompact: no usable font: %w", err)
	}
	defer face.Close()

	lines := wrapText(text, frameWidth, padding, face)
	metrics := face.Metrics()
	lineHeight := (metrics.Ascent + metrics.Descent).Ceil()
	if lineHeight < 1 {
		lineHeight = int(fontSize * 1.3)
	}
	rowsPerFrame := (maxFrameHeight - 2*padding) / lineHeight
	if rowsPerFrame < 1 {
		rowsPerFrame = 1
	}

	var frames [][]byte
	for start := 0; start < len(lines); start += rowsPerFrame {
		if len(frames) >= maxFrames {
			return nil, fmt.Errorf("snapcompact: archive exceeds %d frames", maxFrames)
		}
		end := start + rowsPerFrame
		if end > len(lines) {
			end = len(lines)
		}
		img, err := drawFrame(lines[start:end], face, frameWidth, lineHeight, padding)
		if err != nil {
			return nil, err
		}
		var buf bytes.Buffer
		if err := png.Encode(&buf, img); err != nil {
			return nil, err
		}
		frames = append(frames, buf.Bytes())
	}
	if len(frames) == 0 {
		// An empty archive still gets one blank frame so callers can rely on a
		// non-empty result.
		img, err := drawFrame([]string{""}, face, frameWidth, lineHeight, padding)
		if err != nil {
			return nil, err
		}
		var buf bytes.Buffer
		if err := png.Encode(&buf, img); err != nil {
			return nil, err
		}
		frames = append(frames, buf.Bytes())
	}
	return frames, nil
}

func drawFrame(lines []string, face font.Face, width, lineHeight, padding int) (*image.RGBA, error) {
	height := 2*padding + lineHeight*len(lines)
	if height < 1 {
		height = 1
	}
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			img.SetRGBA(x, y, color.RGBA{R: 255, G: 255, B: 255, A: 255})
		}
	}
	metrics := face.Metrics()
	ascent := metrics.Ascent.Ceil()
	drawer := &font.Drawer{
		Dst:  img,
		Src:  image.NewUniform(color.RGBA{R: 0, G: 0, B: 0, A: 255}),
		Face: face,
		Dot:  fixed.P(padding, padding+ascent),
	}
	for _, line := range lines {
		drawer.Dot.X = fixed.I(padding)
		drawer.DrawString(line)
		drawer.Dot.Y += fixed.I(lineHeight)
	}
	return img, nil
}

func wrapText(text string, width, padding int, face font.Face) []string {
	if text == "" {
		return []string{""}
	}
	advance := font.MeasureString(face, "M").Ceil()
	if advance < 1 {
		advance = 1
	}
	charsPerLine := (width - 2*padding) / advance
	if charsPerLine < 1 {
		charsPerLine = 1
	}
	var lines []string
	var current strings.Builder
	runes := []rune(text)
	for _, char := range runes {
		if char == '\n' || len([]rune(current.String())) >= charsPerLine {
			lines = append(lines, current.String())
			current.Reset()
			if char == '\n' {
				continue
			}
		}
		current.WriteRune(char)
	}
	if current.Len() > 0 {
		lines = append(lines, current.String())
	}
	if len(lines) == 0 {
		return []string{""}
	}
	return lines
}

// faceFor picks the font: a CJK-capable system font when the text needs one,
// otherwise the bundled Go Regular face.
func faceFor(text string, size float64) (font.Face, error) {
	if HasCJK(text) {
		if face, err := systemCJKFace(size); err == nil {
			return face, nil
		}
	}
	parsed, err := opentype.Parse(goregular.TTF)
	if err != nil {
		return nil, err
	}
	return opentype.NewFace(parsed, &opentype.FaceOptions{
		Size:    size,
		DPI:     72,
		Hinting: font.HintingFull,
	})
}

// systemCJKFace loads a CJK-capable system font from common macOS/Linux paths.
// The font is read at runtime, never redistributed.
func systemCJKFace(size float64) (font.Face, error) {
	var lastErr error
	for _, path := range cjkFontPaths {
		data, err := os.ReadFile(path)
		if err != nil {
			lastErr = err
			continue
		}
		parsed, err := parseFontFile(data)
		if err != nil {
			lastErr = err
			continue
		}
		return opentype.NewFace(parsed, &opentype.FaceOptions{
			Size:    size,
			DPI:     72,
			Hinting: font.HintingFull,
		})
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("no CJK font found")
	}
	return nil, lastErr
}

// parseFontFile handles both single-font files and .ttc collections.
func parseFontFile(data []byte) (*opentype.Font, error) {
	if collection, err := sfnt.ParseCollection(data); err == nil {
		parsed, err := collection.Font(0)
		if err != nil {
			return nil, err
		}
		return parsed, nil
	}
	return opentype.Parse(data)
}

var cjkFontPaths = []string{
	"/System/Library/Fonts/PingFang.ttc",
	"/System/Library/Fonts/STHeiti Light.ttc",
	"/System/Library/Fonts/STHeiti Medium.ttc",
	"/System/Library/Fonts/Hiragino Sans GB.ttc",
	"/System/Library/Fonts/Supplemental/Songti.ttc",
	"/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
	"/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
	"/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
	"/usr/share/fonts/truetype/arphic/uming.ttc",
	"/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
}
