// A tiny styled character grid. Diagrams are easier to reason about as
// coordinates than as concatenated strings, but colouring per character would
// emit an escape sequence per cell — so styles are stored per cell and emitted
// as runs at render time.

import { c, displayWidth } from "./theme";

export type CanvasStyle =
  | "accent"
  | "accentDim"
  | "violet"
  | "violetDim"
  | "ok"
  | "warn"
  | "err"
  | "text"
  | "muted"
  | "faint"
  | "rule";

interface Cell {
  char: string;
  style?: CanvasStyle;
  bold?: boolean;
  /**
   * Second half of a double-width glyph. It carries no character of its own —
   * it exists so column arithmetic matches what the terminal actually draws.
   */
  wideTail?: boolean;
}

export class Canvas {
  private readonly cells: Cell[][];

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.cells = Array.from({ length: height }, () => Array.from({ length: width }, () => ({ char: " " })));
  }

  /**
   * Writes `text` at (row, col). Out-of-bounds characters are dropped, not
   * wrapped — a soft-wrapped line would desynchronise the caller's erase walk.
   * CJK and other double-width glyphs consume two columns, which is what the
   * terminal does, so a row is never wider than `width` display columns even
   * when a tool name or an error message is not ASCII.
   */
  put(row: number, col: number, text: string, style?: CanvasStyle, bold = false): void {
    if (row < 0 || row >= this.height) return;
    let target = col;
    for (const char of text) {
      const cells = Math.max(1, displayWidth(char));
      if (target < 0) {
        target += cells;
        continue;
      }
      if (target + cells > this.width) return; // no room left on this row
      this.cells[row][target] = { char, style, bold };
      for (let extra = 1; extra < cells; extra++) {
        this.cells[row][target + extra] = { char: "", style, bold, wideTail: true };
      }
      target += cells;
    }
  }

  plain(): string[] {
    return this.cells.map(row => row.map(cell => (cell.wideTail ? "" : cell.char)).join("").trimEnd());
  }

  render(): string[] {
    return this.cells.map(row => {
      let out = "";
      let run = "";
      let style: CanvasStyle | undefined;
      let bold = false;
      const flush = () => {
        if (!run) return;
        out += paint(run, style, bold);
        run = "";
      };
      for (const cell of row) {
        if (cell.wideTail) continue; // already drawn by its leading half
        if (cell.style !== style || cell.bold !== bold) {
          flush();
          style = cell.style;
          bold = Boolean(cell.bold);
        }
        run += cell.char;
      }
      flush();
      return out.trimEnd();
    });
  }
}

function paint(text: string, style: CanvasStyle | undefined, bold: boolean): string {
  const painted = style ? c[style](text) : text;
  return bold ? c.bold(painted) : painted;
}
