import { describe, expect, test } from "bun:test";
import { ClaudeTaskTable, StreamParser } from "./stream";
import type { StreamEvent } from "./stream";

function feed(format: "claude-json" | "codex-json", ...lines: string[]): StreamEvent[] {
  const parser = new StreamParser(format);
  return lines.flatMap(line => parser.push(`${line}\n`));
}

function plans(events: StreamEvent[]): StreamEvent[] {
  return events.filter(event => event.kind === "plan");
}

describe("claude TodoWrite plans", () => {
  test("assistant tool_use with todos becomes one plan event", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_1",
        role: "assistant",
        content: [
          { type: "text", text: "Let me plan this out." },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "TodoWrite",
            input: {
              todos: [
                { content: "Read stream.ts", status: "completed", activeForm: "Reading stream.ts" },
                { content: "Add plan events", status: "in_progress", activeForm: "Adding plan events" },
                { content: "Write tests", status: "pending", activeForm: "Writing tests" },
              ],
            },
          },
        ],
      },
    });

    const found = plans(feed("claude-json", line));
    expect(found).toHaveLength(1);
    expect(found[0]?.plan).toEqual([
      { text: "Read stream.ts", status: "completed" },
      { text: "Add plan events", status: "in_progress" },
      { text: "Write tests", status: "pending" },
    ]);
  });

  test("a non-TodoWrite tool_use produces no plan event", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "ls -la" } }],
      },
    });
    expect(feed("claude-json", line)).toEqual([]);
  });

  test("streamed tool_use still yields exactly one tool event", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_start", content_block: { type: "tool_use", name: "TodoWrite" } },
    });
    const events = feed("claude-json", line);
    expect(events).toEqual([{ kind: "tool", tool: "TodoWrite" }]);
  });

  test("result still yields a final event", () => {
    const line = JSON.stringify({ type: "result", result: "all done", usage: { input_tokens: 12, output_tokens: 3 } });
    const events = feed("claude-json", line);
    expect(events[0]?.kind).toBe("final");
    expect(events[0]?.finalText).toBe("all done");
  });
});

// Verbatim lines from a real `claude -p --output-format stream-json` run on
// Claude Code 2.1.220, which has no TodoWrite tool at all: its task list is the
// incremental TaskCreate / TaskUpdate pair. Only the task-carrying lines are
// kept (plus one unrelated tool_result, to prove non-text result blocks are
// harmless); the ordering between them is exactly as captured.
const REAL_CAPTURE = `
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01SVApszHjpA984vnNwY7Bci","content":[{"type":"tool_reference","tool_name":"TaskList"},{"type":"tool_reference","tool_name":"TaskCreate"},{"type":"tool_reference","tool_name":"TaskGet"},{"type":"tool_reference","tool_name":"TaskUpdate"},{"type":"tool_reference","tool_name":"CronList"}]}]},"parent_tool_use_id":null,"session_id":"d3844ce5-0fd5-4fff-8329-bad02594411f","uuid":"dba01db0-e675-411a-b5c6-c0f9d99b85df","timestamp":"2026-07-26T15:42:00.049Z","tool_use_result":{"matches":["TaskList","TaskCreate","TaskGet","TaskUpdate","CronList"],"query":"todo list task tracking","total_deferred_tools":82}}
{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_01JfB8i9x5bTDfF5QDwASk8h","name":"TaskCreate","input":{},"caller":{"type":"direct"}}},"session_id":"d3844ce5-0fd5-4fff-8329-bad02594411f","parent_tool_use_id":null,"uuid":"d6039a69-185b-45ef-b10d-d2d91248cf9e"}
{"type":"assistant","message":{"model":"claude-opus-5","id":"msg_011CdQvXC4HUWt9GfVa8m2pE","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01JfB8i9x5bTDfF5QDwASk8h","name":"TaskCreate","input":{"subject":"Identify file type","description":"Determine the binary's file type/format (file, magic bytes, arch, packing).","activeForm":"Identifying file type"},"caller":{"type":"direct"}}],"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":4440,"cache_read_input_tokens":45815,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":4440},"output_tokens":2,"service_tier":"standard","inference_geo":"not_available"},"diagnostics":null,"context_management":null},"parent_tool_use_id":null,"session_id":"d3844ce5-0fd5-4fff-8329-bad02594411f","uuid":"4e227aaf-28b8-40aa-8f84-0c34be9e969e","timestamp":"2026-07-26T15:42:12.621Z","request_id":"req_011CdQvXAY1Zrok9VMfTcxc2"}
{"type":"stream_event","event":{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_0173sConzseqqtbvv6w9Adc1","name":"TaskCreate","input":{},"caller":{"type":"direct"}}},"session_id":"d3844ce5-0fd5-4fff-8329-bad02594411f","parent_tool_use_id":null,"uuid":"14671eff-d4e5-4594-9ff9-3ff2c94985c7"}
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01JfB8i9x5bTDfF5QDwASk8h","type":"tool_result","content":"Task #1 created successfully: Identify file type"}]},"parent_tool_use_id":null,"session_id":"d3844ce5-0fd5-4fff-8329-bad02594411f","uuid":"097e0f26-6425-4b1a-b001-09b440bd77b5","timestamp":"2026-07-26T15:42:13.550Z","tool_use_result":{"task":{"id":"1","subject":"Identify file type"}}}
{"type":"assistant","message":{"model":"claude-opus-5","id":"msg_011CdQvXC4HUWt9GfVa8m2pE","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_0173sConzseqqtbvv6w9Adc1","name":"TaskCreate","input":{"subject":"Extract strings","description":"Extract and review strings from the binary for hints (prompts, error messages, flags).","activeForm":"Extracting strings"},"caller":{"type":"direct"}}],"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":4440,"cache_read_input_tokens":45815,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":4440},"output_tokens":2,"service_tier":"standard","inference_geo":"not_available"},"diagnostics":null,"context_management":null},"parent_tool_use_id":null,"session_id":"d3844ce5-0fd5-4fff-8329-bad02594411f","uuid":"cded78c5-1f4e-4400-a8d4-d1f1eee68f94","timestamp":"2026-07-26T15:42:14.105Z","request_id":"req_011CdQvXAY1Zrok9VMfTcxc2"}
{"type":"stream_event","event":{"type":"content_block_start","index":3,"content_block":{"type":"tool_use","id":"toolu_01GTS24jNWBoaiGaSUjEU75z","name":"TaskCreate","input":{},"caller":{"type":"direct"}}},"session_id":"d3844ce5-0fd5-4fff-8329-bad02594411f","parent_tool_use_id":null,"uuid":"81a75f6e-bab8-497a-891d-ad76e32ac39e"}
{"type":"assistant","message":{"model":"claude-opus-5","id":"msg_011CdQvXC4HUWt9GfVa8m2pE","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01GTS24jNWBoaiGaSUjEU75z","name":"TaskCreate","input":{"subject":"Locate the check function","description":"Find the validation/check function by cross-referencing strings and entry points.","activeForm":"Locating the check function"},"caller":{"type":"direct"}}],"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":4440,"cache_read_input_tokens":45815,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":4440},"output_tokens":2,"service_tier":"standard","inference_geo":"not_available"},"diagnostics":null,"context_management":null},"parent_tool_use_id":null,"session_id":"d3844ce5-0fd5-4fff-8329-bad02594411f","uuid":"c0f0c7ad-159b-452d-b25a-edaf001f220b","timestamp":"2026-07-26T15:42:14.295Z","request_id":"req_011CdQvXAY1Zrok9VMfTcxc2"}
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_0173sConzseqqtbvv6w9Adc1","type":"tool_result","content":"Task #2 created successfully: Extract strings"}]},"parent_tool_use_id":null,"session_id":"d3844ce5-0fd5-4fff-8329-bad02594411f","uuid":"2f6d5d2e-a21f-4007-a636-253757472a5f","timestamp":"2026-07-26T15:42:15.026Z","tool_use_result":{"task":{"id":"2","subject":"Extract strings"}}}
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01GTS24jNWBoaiGaSUjEU75z","type":"tool_result","content":"Task #3 created successfully: Locate the check function"}]},"parent_tool_use_id":null,"session_id":"d3844ce5-0fd5-4fff-8329-bad02594411f","uuid":"6bde2207-6ae2-4f1b-9843-bd6085214f1c","timestamp":"2026-07-26T15:42:15.951Z","tool_use_result":{"task":{"id":"3","subject":"Locate the check function"}}}
{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_01F1pPwXokpvVdKaUMsRgGVc","name":"TaskUpdate","input":{},"caller":{"type":"direct"}}},"session_id":"d3844ce5-0fd5-4fff-8329-bad02594411f","parent_tool_use_id":null,"uuid":"95a07cce-c71a-4b39-ba80-00cef10a559f"}
{"type":"assistant","message":{"model":"claude-opus-5","id":"msg_011CdQvYMAkdYwpj74AhGTH4","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01F1pPwXokpvVdKaUMsRgGVc","name":"TaskUpdate","input":{"taskId":"1","status":"completed"},"caller":{"type":"direct"}}],"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":1109,"cache_read_input_tokens":50255,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":1109},"output_tokens":73,"service_tier":"standard","inference_geo":"not_available"},"diagnostics":null,"context_management":null},"parent_tool_use_id":null,"session_id":"d3844ce5-0fd5-4fff-8329-bad02594411f","uuid":"f1cf13ed-2a43-47cb-8b05-19d5a2d6fc4b","timestamp":"2026-07-26T15:42:18.972Z","request_id":"req_011CdQvYKo9mJAQzuVyPekcQ"}
{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_01DqZFjmPn4jKikptRyt2zub","name":"TaskUpdate","input":{},"caller":{"type":"direct"}}},"session_id":"d3844ce5-0fd5-4fff-8329-bad02594411f","parent_tool_use_id":null,"uuid":"a3bbdf9b-8d0a-4f8c-9c48-8dc2799d7c2d"}
{"type":"assistant","message":{"model":"claude-opus-5","id":"msg_011CdQvYMAkdYwpj74AhGTH4","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01DqZFjmPn4jKikptRyt2zub","name":"TaskUpdate","input":{"taskId":"2","status":"in_progress"},"caller":{"type":"direct"}}],"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":1109,"cache_read_input_tokens":50255,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":1109},"output_tokens":73,"service_tier":"standard","inference_geo":"not_available"},"diagnostics":null,"context_management":null},"parent_tool_use_id":null,"session_id":"d3844ce5-0fd5-4fff-8329-bad02594411f","uuid":"faea1876-1b38-4b36-af96-4f1a60e53b14","timestamp":"2026-07-26T15:42:18.991Z","request_id":"req_011CdQvYKo9mJAQzuVyPekcQ"}
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01F1pPwXokpvVdKaUMsRgGVc","type":"tool_result","content":"Updated task #1 status"}]},"parent_tool_use_id":null,"session_id":"d3844ce5-0fd5-4fff-8329-bad02594411f","uuid":"3df5fe0d-aa41-42c1-a2ea-404e37908352","timestamp":"2026-07-26T15:42:19.948Z","tool_use_result":{"success":true,"taskId":"1","updatedFields":["status"],"statusChange":{"from":"pending","to":"completed"}}}
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01DqZFjmPn4jKikptRyt2zub","type":"tool_result","content":"Updated task #2 status"}]},"parent_tool_use_id":null,"session_id":"d3844ce5-0fd5-4fff-8329-bad02594411f","uuid":"72b0095c-0c1c-4b02-8745-c5390d9a5bda","timestamp":"2026-07-26T15:42:19.950Z","tool_use_result":{"success":true,"taskId":"2","updatedFields":["status"],"statusChange":{"from":"pending","to":"in_progress"}}}
`;

function taskCreate(subject: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: `toolu_${subject}`, name: "TaskCreate", input: { subject } }] },
  });
}

function taskUpdate(input: Record<string, unknown>): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "toolu_u", name: "TaskUpdate", input }] },
  });
}

function taskResult(content: unknown): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_x", content }] },
  });
}

describe("claude TaskCreate/TaskUpdate plans", () => {
  test("the real captured stream ends as completed / in_progress / pending", () => {
    const lines = REAL_CAPTURE.split("\n").filter(line => line.length > 0);
    const found = plans(feed("claude-json", ...lines));

    // One create, one create, one create, then two status changes. The three
    // `Task #N created` results only confirm ids the fallback already guessed.
    expect(found).toHaveLength(5);
    expect(found.at(-1)?.plan).toEqual([
      { id: "1", text: "Identify file type", status: "completed" },
      { id: "2", text: "Extract strings", status: "in_progress" },
      { id: "3", text: "Locate the check function", status: "pending" },
    ]);
  });

  test("every plan event carries the full table, never a delta", () => {
    const lines = REAL_CAPTURE.split("\n").filter(line => line.length > 0);
    const sizes = plans(feed("claude-json", ...lines)).map(event => event.plan?.length);
    expect(sizes).toEqual([1, 2, 3, 3, 3]);
  });

  test("a tool_result binds the id even when the TaskCreate call was missed", () => {
    const found = plans(feed("claude-json", taskResult("Task #7 created successfully: Dump the classes")));
    expect(found).toHaveLength(1);
    expect(found[0]?.plan).toEqual([{ id: "7", text: "Dump the classes", status: "pending" }]);
  });

  test("tool_result content as an array of text blocks works like a plain string", () => {
    const found = plans(
      feed(
        "claude-json",
        taskResult([{ type: "text", text: "Task #1 created successfully: Read the binary" }]),
        taskUpdate({ taskId: "1", status: "completed" }),
      ),
    );
    expect(found.at(-1)?.plan).toEqual([{ id: "1", text: "Read the binary", status: "completed" }]);
  });

  test("a TaskCreate whose result never arrives still yields a step", () => {
    const found = plans(feed("claude-json", taskCreate("Patch the check"), taskCreate("Verify the patch")));
    expect(found).toHaveLength(2);
    expect(found.at(-1)?.plan).toEqual([
      { id: "1", text: "Patch the check", status: "pending" },
      { id: "2", text: "Verify the patch", status: "pending" },
    ]);
  });

  test("a create followed by its result inserts one step, not two", () => {
    const found = plans(
      feed("claude-json", taskCreate("Only once"), taskResult("Task #1 created successfully: Only once")),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.plan).toEqual([{ id: "1", text: "Only once", status: "pending" }]);
  });

  test("a TaskUpdate for an unknown id is ignored", () => {
    const events = feed(
      "claude-json",
      taskCreate("Known step"),
      taskUpdate({ taskId: "99", status: "completed" }),
      taskUpdate({ status: "completed" }),
    );
    const found = plans(events);
    expect(found).toHaveLength(1);
    expect(found[0]?.plan).toEqual([{ id: "1", text: "Known step", status: "pending" }]);
  });

  test("TaskUpdate honours an optional subject rename", () => {
    const found = plans(
      feed("claude-json", taskCreate("Old name"), taskUpdate({ taskId: "1", subject: "New name" })),
    );
    expect(found.at(-1)?.plan).toEqual([{ id: "1", text: "New name", status: "pending" }]);
  });

  test("a fresh table per parser starts empty", () => {
    const first = plans(feed("claude-json", taskCreate("Turn one")));
    const second = plans(feed("claude-json", taskCreate("Turn two")));
    expect(first[0]?.plan).toEqual([{ id: "1", text: "Turn one", status: "pending" }]);
    expect(second[0]?.plan).toEqual([{ id: "1", text: "Turn two", status: "pending" }]);
  });

  // Claude Code keeps one native session across 0xAF turns (cliResumeSession),
  // and its task list is session-scoped. A table that died with the turn left
  // every later TaskUpdate with nothing to update — the plan froze on screen at
  // whatever the first turn produced.
  test("a table shared across turns keeps TaskUpdate working after a resume", () => {
    const tasks = new ClaudeTaskTable();
    const turn = (...lines: string[]) => {
      const parser = new StreamParser("claude-json", tasks);
      return plans(lines.flatMap(line => parser.push(`${line}\n`)));
    };

    turn(taskCreate("Locate the check"), taskResult("Task #1 created successfully: Locate the check"));
    const second = turn(taskUpdate({ taskId: "1", status: "completed" }));

    expect(second.at(-1)?.plan).toEqual([{ id: "1", text: "Locate the check", status: "completed" }]);
  });

  test("the structured tool_use_result binds without any result text", () => {
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_x", content: [] }] },
      tool_use_result: { task: { id: "4", subject: "Dump the classes" } },
    });
    expect(plans(feed("claude-json", line))[0]?.plan).toEqual([
      { id: "4", text: "Dump the classes", status: "pending" },
    ]);
  });

  test("a structured statusChange applies even when the TaskUpdate call was lost", () => {
    // The TaskUpdate tool_use never arrives — only its result does. Losing that
    // one event would otherwise strand the step on `pending` forever.
    const found = plans(
      feed(
        "claude-json",
        taskCreate("Locate the check"),
        JSON.stringify({
          type: "user",
          message: { role: "user", content: [{ type: "tool_result", content: "Updated task #1 status" }] },
          tool_use_result: { success: true, taskId: "1", updatedFields: ["status"], statusChange: { from: "pending", to: "completed" } },
        }),
      ),
    );
    expect(found.at(-1)?.plan).toEqual([{ id: "1", text: "Locate the check", status: "completed" }]);
  });

  test("structured binding wins over a disagreeing result text", () => {
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", content: "Task #9 created successfully: Stale prose" }] },
      tool_use_result: { task: { id: "2", subject: "Structured wins" } },
    });
    expect(plans(feed("claude-json", line))[0]?.plan).toEqual([
      { id: "2", text: "Structured wins", status: "pending" },
    ]);
  });

  test("the structured and regex paths agree on the real capture", () => {
    const lines = REAL_CAPTURE.split("\n").filter(line => line.length > 0);
    // Same stream with the structured binding stripped, forcing the prose path.
    const proseOnly = lines.map(line => {
      const event = JSON.parse(line) as Record<string, unknown>;
      delete event.tool_use_result;
      return JSON.stringify(event);
    });

    const structured = plans(feed("claude-json", ...lines));
    const regex = plans(feed("claude-json", ...proseOnly));
    expect(regex.at(-1)?.plan).toEqual(structured.at(-1)?.plan as never);
    expect(regex.map(event => event.plan?.length)).toEqual(structured.map(event => event.plan?.length));
  });

  test("sub-agent events never touch the operator's task table", () => {
    const subAgent = (line: string): string => {
      const event = JSON.parse(line) as Record<string, unknown>;
      event.parent_tool_use_id = "toolu_subagent";
      return JSON.stringify(event);
    };

    const events = feed(
      "claude-json",
      taskCreate("Operator step"),
      // A spawned sub-agent runs its own task list; none of it is the plan.
      subAgent(taskCreate("Sub-agent step")),
      subAgent(taskUpdate({ taskId: "1", status: "completed" })),
      subAgent(taskResult("Task #2 created successfully: Sub-agent result")),
      subAgent(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "tool_use", name: "TodoWrite", input: { todos: [{ content: "Sub-agent todo", status: "pending" }] } }],
          },
        }),
      ),
    );

    const found = plans(events);
    expect(found).toHaveLength(1);
    expect(found[0]?.plan).toEqual([{ id: "1", text: "Operator step", status: "pending" }]);
  });

  test("malformed Task events never throw and never emit a plan", () => {
    const events = feed(
      "claude-json",
      taskCreate(""),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "TaskCreate", input: null }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "TaskCreate", input: { subject: 7 } }] } }),
      JSON.stringify({ type: "user", message: { content: "Task #1 created successfully: not in a block" } }),
      taskResult(null),
      taskResult([{ type: "tool_reference", tool_name: "TaskList" }]),
      taskResult("Updated task #1 status"),
      JSON.stringify({ type: "user" }),
      // Unusable structured shapes: fall through to the prose path, find nothing.
      JSON.stringify({ type: "user", tool_use_result: "nonsense" }),
      JSON.stringify({ type: "user", tool_use_result: { task: "not a record" } }),
      JSON.stringify({ type: "user", tool_use_result: { task: { id: "1" } } }),
      JSON.stringify({ type: "user", tool_use_result: { task: { subject: "no id" } } }),
      // A structured update for an id that was never created is ignored.
      JSON.stringify({ type: "user", tool_use_result: { taskId: "99", statusChange: { to: "completed" } } }),
    );
    expect(plans(events)).toEqual([]);
  });
});

describe("codex plans", () => {
  test("legacy plan_update carries steps and explanation", () => {
    const line = JSON.stringify({
      id: "0",
      msg: {
        type: "plan_update",
        explanation: "Splitting the work into three steps",
        plan: [
          { step: "Inspect the binary", status: "completed" },
          { step: "Locate the check", status: "in_progress" },
          { step: "Patch it", status: "pending" },
        ],
      },
    });

    const found = plans(feed("codex-json", line));
    expect(found).toHaveLength(1);
    expect(found[0]?.planNote).toBe("Splitting the work into three steps");
    expect(found[0]?.plan).toEqual([
      { text: "Inspect the binary", status: "completed" },
      { text: "Locate the check", status: "in_progress" },
      { text: "Patch it", status: "pending" },
    ]);
  });

  test("item.completed todo_list under item.type", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: {
        id: "item_1",
        type: "todo_list",
        items: [
          { text: "Set up the harness", completed: true },
          { text: "Run the tests", completed: false },
        ],
      },
    });

    const found = plans(feed("codex-json", line));
    expect(found).toHaveLength(1);
    expect(found[0]?.plan).toEqual([
      { text: "Set up the harness", status: "completed" },
      { text: "Run the tests", status: "pending" },
    ]);
  });

  test("item.completed todo_list under item_type, with todo_items and step keys", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: {
        id: "item_2",
        item_type: "todo_list",
        todo_items: [
          { step: "Dump the classes", completed: false },
          { step: "Hook the method", completed: true },
        ],
      },
    });

    const found = plans(feed("codex-json", line));
    expect(found).toHaveLength(1);
    expect(found[0]?.plan).toEqual([
      { text: "Dump the classes", status: "pending" },
      { text: "Hook the method", status: "completed" },
    ]);
  });
});

describe("malformed input", () => {
  test("invalid JSON, missing message, bad todos and null plan are ignored", () => {
    const claude = feed(
      "claude-json",
      "{not json at all",
      JSON.stringify({ type: "assistant" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "TodoWrite", input: { todos: "pending" } }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "TodoWrite", input: null }] } }),
    );
    expect(claude).toEqual([]);

    const codex = feed(
      "codex-json",
      "{oops",
      JSON.stringify({ msg: { type: "plan_update", plan: null } }),
      JSON.stringify({ msg: { type: "plan_update", plan: [{ notAStep: 1 }, null, "text"] } }),
      JSON.stringify({ type: "item.completed", item: { type: "todo_list" } }),
      JSON.stringify({ type: "item.completed", item: { item_type: "todo_list", items: 7 } }),
    );
    expect(plans(codex)).toEqual([]);
  });

  test("unknown statuses fall back to pending", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "TodoWrite", input: { todos: [{ content: "Do it", status: "blocked" }] } }] },
    });
    expect(plans(feed("claude-json", line))[0]?.plan).toEqual([{ text: "Do it", status: "pending" }]);
  });
});

describe("chunked feeding", () => {
  test("a line split across two pushes still emits its event", () => {
    const line = JSON.stringify({
      msg: {
        type: "plan_update",
        explanation: "half now, half later",
        plan: [{ step: "Buffered step", status: "in_progress" }],
      },
    });
    const split = Math.floor(line.length / 2);

    const parser = new StreamParser("codex-json");
    expect(parser.push(line.slice(0, split))).toEqual([]);
    const events = parser.push(`${line.slice(split)}\n`);

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("plan");
    expect(events[0]?.planNote).toBe("half now, half later");
    expect(events[0]?.plan).toEqual([{ text: "Buffered step", status: "in_progress" }]);
  });
});
