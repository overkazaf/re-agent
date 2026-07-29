// Package mcp is a minimal MCP client (stdio transport, JSON-RPC 2.0 over
// newline-delimited JSON) plus the adapter that turns a server's tools into
// native agent tools. Enough to borrow another process's tools —
// ida-pro-mcp being the one that matters here — without pulling in an SDK.
package mcp

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"time"

	"github.com/overkazaf/re-agent/internal/auth"
	"github.com/overkazaf/re-agent/internal/types"
)

const protocolVersion = "2024-11-05"

var clientInfo = map[string]any{"name": "0xaf-re-agent", "version": "0.1.4"}

type ToolInfo struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

type rpcMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      *int            `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  any             `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

type pending struct {
	result chan json.RawMessage
	fail   chan error
}

type Client struct {
	Name   string
	Config *types.MCPServerConfig

	cmd    *exec.Cmd
	stdin  io.WriteCloser
	mu     sync.Mutex
	nextID int
	calls  map[int]pending
	tools  []ToolInfo

	closed     bool
	exitReason string
	// pumped closes when the stdout reader has seen EOF. cmd.Wait() closes the
	// pipes, so it must not run until the reader is finished or a server's last
	// frame can be torn out from under the scanner.
	pumped chan struct{}
}

func Connect(name string, config *types.MCPServerConfig) (*Client, error) {
	cmd := exec.Command(config.Command, config.Args...)
	cmd.Dir = config.Cwd
	env := auth.FilteredEnv(nil)
	for key, value := range config.Env {
		env = append(env, key+"="+value)
	}
	cmd.Env = env

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}

	client := &Client{
		Name: name, Config: config, cmd: cmd, stdin: stdin,
		nextID: 1, calls: map[int]pending{}, pumped: make(chan struct{}),
	}
	go client.pump(stdout)
	go client.watchExit(stderr)

	if _, err := client.request("initialize", map[string]any{
		"protocolVersion": protocolVersion,
		"capabilities":    map[string]any{},
		"clientInfo":      clientInfo,
	}, nil); err != nil {
		client.Close()
		return nil, err
	}
	client.notify("notifications/initialized", map[string]any{})

	raw, err := client.request("tools/list", map[string]any{}, nil)
	if err != nil {
		client.Close()
		return nil, err
	}
	var listed struct {
		Tools []ToolInfo `json:"tools"`
	}
	if err := json.Unmarshal(raw, &listed); err != nil {
		client.Close()
		return nil, err
	}
	for _, tool := range listed.Tools {
		if len(config.Tools) > 0 && !contains(config.Tools, tool.Name) {
			continue
		}
		client.tools = append(client.tools, tool)
	}
	return client, nil
}

func (c *Client) Available() []ToolInfo { return c.tools }

func (c *Client) Alive() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return !c.closed && c.exitReason == ""
}

func (c *Client) Status() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.exitReason != "" {
		return c.exitReason
	}
	if c.closed {
		return "closed"
	}
	return "ready"
}

type CallResult struct {
	Content []types.ContentBlock
	IsError bool
}

func (c *Client) CallTool(tool string, args map[string]any, ctx context.Context) (CallResult, error) {
	raw, err := c.request("tools/call", map[string]any{"name": tool, "arguments": args}, ctx)
	if err != nil {
		return CallResult{}, err
	}
	var parsed struct {
		Content []map[string]any `json:"content"`
		IsError bool             `json:"isError"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return CallResult{}, err
	}
	return CallResult{Content: toBlocks(parsed.Content), IsError: parsed.IsError}, nil
}

func (c *Client) Close() {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	waiting := c.calls
	c.calls = map[int]pending{}
	c.mu.Unlock()

	for id, call := range waiting {
		call.fail <- fmt.Errorf("MCP server '%s' closed before request %d answered", c.Name, id)
	}
	_ = c.stdin.Close()
	if c.cmd.Process != nil {
		_ = c.cmd.Process.Kill()
	}
}

func (c *Client) request(method string, params any, ctx context.Context) (json.RawMessage, error) {
	c.mu.Lock()
	if c.closed {
		status := c.exitReason
		c.mu.Unlock()
		if status == "" {
			status = "closed"
		}
		return nil, fmt.Errorf("MCP server '%s' is not connected (%s)", c.Name, status)
	}
	id := c.nextID
	c.nextID++
	call := pending{result: make(chan json.RawMessage, 1), fail: make(chan error, 1)}
	c.calls[id] = call
	c.mu.Unlock()

	timeoutMs := c.Config.TimeoutMs
	if timeoutMs == 0 {
		timeoutMs = 60_000
	}
	if err := c.write(rpcMessage{JSONRPC: "2.0", ID: &id, Method: method, Params: params}); err != nil {
		c.forget(id)
		return nil, err
	}

	var cancelled <-chan struct{}
	if ctx != nil {
		cancelled = ctx.Done()
	}
	select {
	case result := <-call.result:
		return result, nil
	case err := <-call.fail:
		return nil, err
	case <-time.After(time.Duration(timeoutMs) * time.Millisecond):
		c.forget(id)
		return nil, fmt.Errorf("MCP '%s' %s timed out after %dms", c.Name, method, timeoutMs)
	case <-cancelled:
		c.forget(id)
		return nil, fmt.Errorf("interrupted by operator")
	}
}

func (c *Client) forget(id int) {
	c.mu.Lock()
	delete(c.calls, id)
	c.mu.Unlock()
}

func (c *Client) notify(method string, params any) {
	_ = c.write(rpcMessage{JSONRPC: "2.0", Method: method, Params: params})
}

func (c *Client) write(payload rpcMessage) error {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	_, err = c.stdin.Write(append(encoded, '\n'))
	return err
}

// pump reads newline-delimited JSON-RPC frames until the process ends.
func (c *Client) pump(stdout io.Reader) {
	defer close(c.pumped)
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var message rpcMessage
		if err := json.Unmarshal(line, &message); err != nil {
			continue // servers sometimes log plain text to stdout; ignore it
		}
		if message.ID == nil {
			continue // notification from the server
		}
		c.mu.Lock()
		call, ok := c.calls[*message.ID]
		delete(c.calls, *message.ID)
		c.mu.Unlock()
		if !ok {
			continue
		}
		if message.Error != nil {
			call.fail <- fmt.Errorf("MCP '%s': %s", c.Name, message.Error.Message)
			continue
		}
		call.result <- message.Result
	}
}

func (c *Client) watchExit(stderr io.Reader) {
	captured, _ := io.ReadAll(stderr)
	<-c.pumped // reaping the child closes the pipes; let the reader finish first
	err := c.cmd.Wait()
	code := 0
	if err != nil {
		code = -1
		var exitErr *exec.ExitError
		if ok := asExit(err, &exitErr); ok {
			code = exitErr.ExitCode()
		}
	}
	detail := lastLines(string(captured), 2)
	c.mu.Lock()
	if detail != "" {
		c.exitReason = fmt.Sprintf("exited (code %d): %s", code, detail)
	} else {
		c.exitReason = fmt.Sprintf("exited (code %d)", code)
	}
	c.mu.Unlock()
	c.Close()
}

func asExit(err error, target **exec.ExitError) bool {
	for err != nil {
		if typed, ok := err.(*exec.ExitError); ok {
			*target = typed
			return true
		}
		unwrapper, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = unwrapper.Unwrap()
	}
	return false
}

func toBlocks(content []map[string]any) []types.ContentBlock {
	var blocks []types.ContentBlock
	for _, item := range content {
		kind, _ := item["type"].(string)
		switch kind {
		case "text":
			if text, ok := item["text"].(string); ok {
				blocks = append(blocks, types.TextBlock(text))
				continue
			}
		case "image":
			if data, ok := item["data"].(string); ok {
				mime, _ := item["mimeType"].(string)
				if mime == "" {
					mime = "image/png"
				}
				blocks = append(blocks, types.ContentBlock{Type: "image", Data: data, MimeType: mime})
				continue
			}
		}
		// resource links and anything newer: keep the payload rather than drop it
		encoded, _ := json.Marshal(item)
		blocks = append(blocks, types.TextBlock(string(encoded)))
	}
	return blocks
}

func contains(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}

func lastLines(text string, count int) string {
	trimmed := trimSpace(text)
	if trimmed == "" {
		return ""
	}
	lines := splitLines(trimmed)
	if len(lines) > count {
		lines = lines[len(lines)-count:]
	}
	return joinWithSpace(lines)
}
